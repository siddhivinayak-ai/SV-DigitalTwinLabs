// REST helpers for the TwinLabs API (same origin; Vite proxies /api in dev).
// Errors are RFC 7807 problem+json and are turned into readable messages.

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly problem?: ProblemDetails) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  errors?: Record<string, string[]>;
}

/** Turn a problem+json body (or anything else) into a one-line message (pure). */
export function problemMessage(status: number, statusText: string, body: unknown): string {
  if (body && typeof body === 'object') {
    const p = body as ProblemDetails;
    const parts: string[] = [];
    if (p.title) parts.push(p.title);
    if (p.detail && p.detail !== p.title) parts.push(p.detail);
    if (p.errors) {
      for (const [field, msgs] of Object.entries(p.errors)) parts.push(`${field}: ${msgs.join(' ')}`);
    }
    if (parts.length) return `${parts.join(' — ')} (HTTP ${status})`;
  }
  if (typeof body === 'string' && body.trim()) return `${body.trim().slice(0, 200)} (HTTP ${status})`;
  return `HTTP ${status}${statusText ? ' ' + statusText : ''}`;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class Api {
  constructor(private readonly base = '/api', private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init)) {}

  url(path: string): string { return `${this.base}${path}`; }

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl?.signal,
      });
    } catch (e) {
      const aborted = (e as Error)?.name === 'AbortError';
      throw new ApiError(aborted ? `Request timed out after ${Math.round(timeoutMs / 1000)} s` : `Server unreachable (${(e as Error)?.message ?? e})`, 0);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const type = res.headers.get('content-type') ?? '';
    const isJson = type.includes('json');
    const payload: unknown = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '');
    if (!res.ok) throw new ApiError(problemMessage(res.status, res.statusText, payload), res.status, isJson ? (payload as ProblemDetails) : undefined);
    return payload as T;
  }

  get<T>(path: string): Promise<T> { return this.request<T>('GET', path); }
  post<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> { return this.request<T>('POST', path, body ?? {}, timeoutMs); }
}
