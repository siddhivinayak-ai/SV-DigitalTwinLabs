import type { AckData, CommandData, HistorySeries, WhatIfRequest, WhatIfResult } from './contracts';

/** Anything that feeds the store: the live WebSocket client or the in-browser mock. */
export interface TwinSource {
  readonly kind: 'live' | 'mock';
  connect(): void;
  disconnect(): void;
  /** Send a command; resolves with the server's ack. */
  command(cmd: Omit<CommandData, 'id'>): Promise<AckData>;
  whatIf(req: WhatIfRequest): Promise<WhatIfResult>;
  history(sensorId: string, seconds: number): Promise<HistorySeries>;
  /** URL that downloads CSV, or null if unsupported. */
  exportCsvUrl(seconds?: number): string | null;
}
