// Live TwinSource: WebSocket for the stream + commands, REST for what-if and history.
// Reconnects with exponential backoff (0.5 s → 10 s) and reports state via store.setConnection.
import type { AckData, ClientMessage, CommandData, HistorySeries, ServerMessage, WhatIfRequest, WhatIfResult } from './contracts';
import type { TwinSource } from './source';
import type { TwinStore } from '../state/store';
import { Api } from './api';

/** Minimal WebSocket surface so tests can inject a fake. */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

export interface TwinClientOptions {
  url?: string;
  wsFactory?: WsFactory;
  api?: Api;
  ackTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

const WS_OPEN = 1;

/** Reconnect delay for the n-th consecutive failure (0-based): 0.5, 1, 2, 4, 8, 10, 10 … s. */
export function backoffDelay(attempt: number, minMs = 500, maxMs = 10_000): number {
  return Math.min(maxMs, minMs * 2 ** Math.max(0, attempt));
}

export function defaultWsUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

interface Pending { resolve: (a: AckData) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class TwinClient implements TwinSource {
  readonly kind = 'live' as const;
  private ws: WsLike | null = null;
  private stopped = true;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, Pending>();
  private cmdSeq = 0;
  private clientSeq = 0;
  private readonly url: string;
  private readonly factory: WsFactory;
  private readonly api: Api;
  private readonly ackTimeoutMs: number;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  /** Wall-clock ms when the next reconnect attempt fires (for the status bar), or null. */
  nextRetryAt: number | null = null;
  /** True once a socket has opened at least once. */
  everConnected = false;
  /** Number of frames whose seq skipped ahead (diagnostics). */
  seqGaps = 0;
  private lastSeq = 0;

  constructor(private readonly store: TwinStore, opt: TwinClientOptions = {}) {
    this.url = opt.url ?? defaultWsUrl(location);
    this.factory = opt.wsFactory ?? ((u) => new WebSocket(u) as unknown as WsLike);
    this.api = opt.api ?? new Api('/api');
    this.ackTimeoutMs = opt.ackTimeoutMs ?? 5000;
    this.minBackoff = opt.minBackoffMs ?? 500;
    this.maxBackoff = opt.maxBackoffMs ?? 10_000;
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.onerror = null; ws.onopen = null; ws.close(1000, 'client disconnect'); }
    this.failPending('Disconnected');
    this.store.setConnection('disconnected');
  }

  /** Force an immediate reconnect attempt (e.g. user clicked "Retry"). */
  retryNow(): void {
    if (this.stopped || this.ws) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.open();
  }

  command(cmd: Omit<CommandData, 'id'>): Promise<AckData> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return Promise.reject(new Error('Not connected to the twin server'));
    const id = `ui-${++this.cmdSeq}-${Date.now().toString(36)}`;
    const msg: ClientMessage = { type: 'command', t: this.store.sim.simTimeMs, seq: ++this.clientSeq, data: { ...cmd, id } };
    return new Promise<AckData>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`No acknowledgement for '${cmd.action}' within ${Math.round(this.ackTimeoutMs / 1000)} s`));
      }, this.ackTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Send failed: ${(e as Error)?.message ?? e}`));
      }
    });
  }

  whatIf(req: WhatIfRequest): Promise<WhatIfResult> {
    return this.api.post<WhatIfResult>('/whatif', req, 300_000);
  }

  history(sensorId: string, seconds: number): Promise<HistorySeries> {
    return this.api.get<HistorySeries>(`/history/${encodeURIComponent(sensorId)}?seconds=${Math.round(seconds)}`);
  }

  exportCsvUrl(seconds = 3600): string | null {
    return this.api.url(`/export/csv?seconds=${Math.round(seconds)}`);
  }

  get pendingCount(): number { return this.pending.size; }

  // ---------- internals ----------

  private open(): void {
    this.nextRetryAt = null;
    this.store.setConnection('connecting');
    let ws: WsLike;
    try {
      ws = this.factory(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.everConnected = true;
      this.lastSeq = 0;
      this.store.setConnection('connected');
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failPending('Connection lost');
      if (this.stopped) return;
      this.store.setConnection('disconnected');
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt++, this.minBackoff, this.maxBackoff);
    this.nextRetryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (!this.stopped) this.open(); }, delay);
  }

  private onMessage(raw: unknown): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as ServerMessage;
    } catch {
      console.warn('[TwinClient] dropped malformed frame');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (this.lastSeq && msg.seq > this.lastSeq + 1) this.seqGaps++;
    this.lastSeq = msg.seq;
    this.store.apply(msg);
    if (msg.type === 'ack') {
      const p = this.pending.get(msg.data.commandId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.data.commandId);
        p.resolve(msg.data);
      }
    }
  }

  private failPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
