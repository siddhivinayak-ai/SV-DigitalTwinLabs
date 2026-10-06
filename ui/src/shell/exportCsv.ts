// CSV export. Live: download from the server. Demo: build from client-side history with the
// same columns as the server (simTimeMs, then one column per sensor id).
import type { Series } from '../state/store';

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Align sensor histories on their union of sample times (pure). Missing samples are blank. */
export function historyToCsv(sensorIds: string[], get: (id: string) => Series, sinceS = -Infinity): string {
  const cols = sensorIds.map((id) => {
    const s = get(id);
    const m = new Map<number, number>();
    for (let i = 0; i < s.t.length; i++) if (s.t[i] >= sinceS) m.set(Math.round(s.t[i] * 1000), s.v[i]);
    return m;
  });
  const times = new Set<number>();
  for (const m of cols) for (const t of m.keys()) times.add(t);
  const sorted = [...times].sort((a, b) => a - b);
  const lines = [['simTimeMs', ...sensorIds].map(csvCell).join(',')];
  for (const t of sorted) {
    const row = [String(t)];
    for (const m of cols) { const v = m.get(t); row.push(v === undefined ? '' : String(v)); }
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

export function downloadText(filename: string, text: string, mime = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  downloadUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadUrl(url: string, filename?: string): void {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
}
