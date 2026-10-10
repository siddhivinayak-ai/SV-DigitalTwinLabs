// Local plant validator: the fallback when POST /api/plant/validate is unreachable (demo mode).
// Mirrors the codes in docs/V0.3-PlantBuilder.md §3 except BINDING_* (server-only).
import type { PlantModel, ValidationIssue, ValidationResult } from '../net/contracts';
import { checkParam, isValidId, KINDS, REQUIRED_PARAMS, RESOURCE_KINDS } from './model';
import { footprintsOverlap } from './geometry';

export function validatePlant(p: PlantModel): ValidationResult {
  const issues: ValidationIssue[] = [];
  const crit = (code: string, message: string, assetId?: string) => issues.push({ severity: 'critical', code, message, ...(assetId ? { assetId } : {}) });
  const warn = (code: string, message: string, assetId?: string) => issues.push({ severity: 'warning', code, message, ...(assetId ? { assetId } : {}) });

  const assets = p.assets ?? [];
  if (!assets.length) crit('EMPTY_PLANT', 'The plant has no assets');

  // ---- ids ----
  const dup = (kind: string, ids: string[], assetOf?: (id: string) => string | undefined) => {
    const seen = new Set<string>();
    const reported = new Set<string>();
    for (const id of ids) {
      if (seen.has(id) && !reported.has(id)) { reported.add(id); crit('DUPLICATE_ID', `Duplicate ${kind} id '${id}'`, assetOf?.(id)); }
      seen.add(id);
    }
  };
  dup('asset', assets.map((a) => a.id), (id) => id);
  dup('sensor', p.sensors.map((s) => s.id), (id) => p.sensors.find((s) => s.id === id)?.assetId);
  dup('line', (p.lines ?? []).map((l) => l.id));
  dup('resource', (p.resources ?? []).map((r) => r.id));
  dup('shift', (p.calendar?.shifts ?? []).map((s) => s.id));
  dup('connection', (p.connections ?? []).map((c) => c.id));
  for (const a of assets) if (!isValidId(a.id)) crit('BAD_ID', `Asset id '${a.id}' is empty or has characters outside A-Za-z0-9._-`, a.id || undefined);
  for (const s of p.sensors) if (!isValidId(s.id)) crit('BAD_ID', `Sensor id '${s.id}' is empty or has invalid characters`, s.assetId);

  const byId = new Map(assets.map((a) => [a.id, a]));
  const sources = assets.filter((a) => a.kind === 'source');
  const sinks = assets.filter((a) => a.kind === 'sink');
  if (assets.length && !sources.length) crit('NO_SOURCE', 'The plant needs at least one source');
  if (assets.length && !sinks.length) crit('NO_SINK', 'The plant needs at least one sink');

  // ---- edges ----
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  for (const a of assets) { out.set(a.id, []); inn.set(a.id, []); }
  for (const a of assets) {
    for (const d of a.downstream) {
      if (!byId.has(d)) { crit('UNKNOWN_DOWNSTREAM', `${a.id} flows to unknown asset '${d}'`, a.id); continue; }
      if (d === a.id) { crit('SELF_LOOP', `${a.id} flows into itself`, a.id); continue; }
      out.get(a.id)!.push(d);
      inn.get(d)!.push(a.id);
    }
  }
  for (const a of assets) {
    if (a.kind === 'source' && inn.get(a.id)!.length) crit('SOURCE_HAS_UPSTREAM', `Source ${a.id} has upstream (${inn.get(a.id)!.join(', ')})`, a.id);
    if (a.kind === 'sink' && a.downstream.length) crit('SINK_HAS_DOWNSTREAM', `Sink ${a.id} has downstream`, a.id);
  }

  // ---- cycles (iterative DFS, one issue per back edge's cycle) ----
  const color = new Map<string, 0 | 1 | 2>();
  const reportedCycle = new Set<string>();
  for (const start of assets) {
    if (color.get(start.id)) continue;
    const stack: { id: string; i: number }[] = [{ id: start.id, i: 0 }];
    const path: string[] = [start.id];
    color.set(start.id, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = out.get(top.id)![top.i++];
      if (next === undefined) { color.set(top.id, 2); stack.pop(); path.pop(); continue; }
      const c = color.get(next) ?? 0;
      if (c === 0) { color.set(next, 1); stack.push({ id: next, i: 0 }); path.push(next); }
      else if (c === 1) {
        const cyc = path.slice(path.indexOf(next));
        const key = [...cyc].sort().join('|');
        if (!reportedCycle.has(key)) {
          reportedCycle.add(key);
          crit('CYCLE', `Flow cycle: ${[...cyc, next].join(' → ')}`, next);
        }
      }
    }
  }

  // ---- reachability ----
  const reach = (seeds: string[], adj: Map<string, string[]>) => {
    const seen = new Set(seeds);
    const q = [...seeds];
    while (q.length) for (const n of adj.get(q.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    return seen;
  };
  const fromSource = reach(sources.map((a) => a.id), out);
  const toSink = reach(sinks.map((a) => a.id), inn);
  for (const a of assets) {
    const dead = a.kind !== 'sink' && a.downstream.length === 0;
    if (dead) crit('DEAD_END', `${a.id} has no downstream`, a.id);
    if (sources.length && a.kind !== 'source' && !fromSource.has(a.id)) crit('UNREACHABLE', `${a.id} is not reachable from any source`, a.id);
    if (sinks.length && !dead && a.kind !== 'sink' && !toSink.has(a.id)) crit('NO_SINK_REACHABLE', `${a.id} has no path to a sink`, a.id);
  }

  // ---- params ----
  for (const a of assets) {
    if (!(KINDS as string[]).includes(a.kind)) continue;
    for (const k of REQUIRED_PARAMS[a.kind]) if (a.params[k] === undefined) crit('MISSING_PARAM', `${a.id}: required parameter '${k}' is missing`, a.id);
    for (const [k, v] of Object.entries(a.params)) {
      const why = checkParam(k, v);
      if (why) crit('BAD_PARAM', `${a.id}.${k} = ${v}: ${why}`, a.id);
    }
  }

  // ---- references ----
  const lineIds = new Set((p.lines ?? []).map((l) => l.id));
  const resIds = new Set((p.resources ?? []).map((r) => r.id));
  const shiftIds = new Set((p.calendar?.shifts ?? []).map((s) => s.id));
  for (const s of p.sensors) if (!byId.has(s.assetId)) crit('UNKNOWN_REF', `Sensor ${s.id} refers to unknown asset '${s.assetId}'`);
  for (const a of assets) {
    if (a.lineId !== undefined && !lineIds.has(a.lineId)) crit('UNKNOWN_REF', `${a.id}: unknown line '${a.lineId}'`, a.id);
    if (a.resourceId !== undefined && !resIds.has(a.resourceId)) crit('UNKNOWN_REF', `${a.id}: unknown resource '${a.resourceId}'`, a.id);
    if (a.shiftId !== undefined && !shiftIds.has(a.shiftId)) crit('UNKNOWN_REF', `${a.id}: unknown shift '${a.shiftId}'`, a.id);
    if (a.resourceId !== undefined && !RESOURCE_KINDS.includes(a.kind)) crit('RESOURCE_KIND', `${a.id}: a ${a.kind} cannot use a resource`, a.id);
  }
  for (const r of p.resources ?? []) if (!(r.count >= 1)) crit('BAD_RESOURCE_COUNT', `Resource ${r.id}: count must be ≥ 1`);
  for (const s of p.calendar?.shifts ?? []) {
    const bad = !(s.startHour >= 0 && s.startHour <= 24 && s.endHour >= 0 && s.endHour <= 24) || s.startHour === s.endHour;
    if (bad) crit('BAD_SHIFT', `Shift ${s.id}: hours must be within 0..24 and start ≠ end`);
  }

  // ---- warnings ----
  for (let i = 0; i < assets.length; i++) {
    for (let j = i + 1; j < assets.length; j++) {
      if (footprintsOverlap(assets[i], assets[j])) warn('OVERLAP', `${assets[i].id} overlaps ${assets[j].id}`, assets[i].id);
    }
  }
  for (const s of p.sensors) {
    if (s.hi !== undefined && s.hiHi !== undefined && s.hiHi <= s.hi) warn('LIMIT_ORDER', `Sensor ${s.id}: hiHi (${s.hiHi}) ≤ hi (${s.hi})`, s.assetId);
  }
  const withSensors = new Set(p.sensors.map((s) => s.assetId));
  for (const a of assets) if (RESOURCE_KINDS.includes(a.kind) && !withSensors.has(a.id)) warn('NO_SENSORS', `${a.id} has no sensors`, a.id);
  for (const a of assets) if (a.mesh && !a.mesh.startsWith('/api/meshes/')) warn('MESH_URL', `${a.id}: mesh should start with /api/meshes/`, a.id);

  return { ok: !issues.some((x) => x.severity === 'critical'), issues };
}

/** Highest severity per asset, for canvas markers. */
export function issuesByAsset(issues: ValidationIssue[]): Map<string, 'critical' | 'warning'> {
  const m = new Map<string, 'critical' | 'warning'>();
  for (const i of issues) {
    if (!i.assetId || i.severity === 'info') continue;
    if (i.severity === 'critical' || !m.has(i.assetId)) m.set(i.assetId, i.severity);
  }
  return m;
}
