import { describe, expect, it } from 'vitest';
import { Api, ApiError, problemMessage } from './api';

describe('problemMessage', () => {
  it('uses title and detail of problem+json', () => {
    expect(problemMessage(404, 'Not Found', { title: 'Unknown asset', detail: "No asset 'X-9'", status: 404 }))
      .toBe("Unknown asset — No asset 'X-9' (HTTP 404)");
  });
  it('includes validation errors', () => {
    expect(problemMessage(400, 'Bad Request', { title: 'Validation failed', errors: { durationS: ['must be > 0'] } }))
      .toBe('Validation failed — durationS: must be > 0 (HTTP 400)');
  });
  it('falls back to text or status', () => {
    expect(problemMessage(502, 'Bad Gateway', 'upstream down')).toBe('upstream down (HTTP 502)');
    expect(problemMessage(500, 'Internal Server Error', null)).toBe('HTTP 500 Internal Server Error');
  });
});

describe('Api', () => {
  it('throws ApiError with a readable message on problem+json', async () => {
    const api = new Api('/api', async () => new Response(JSON.stringify({ title: 'Bad value', detail: 'speed out of range' }), {
      status: 400, headers: { 'content-type': 'application/problem+json' },
    }));
    const err = await api.post('/sim/speed', { value: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).message).toBe('Bad value — speed out of range (HTTP 400)');
  });
  it('reports network failures', async () => {
    const api = new Api('/api', async () => { throw new TypeError('Failed to fetch'); });
    await expect(api.get('/health')).rejects.toThrow(/Server unreachable/);
  });
  it('sends JSON bodies', async () => {
    let seen: RequestInit | undefined;
    const api = new Api('/api', async (_u, init) => { seen = init; return new Response('{"ok":1}', { headers: { 'content-type': 'application/json' } }); });
    await expect(api.post<{ ok: number }>('/whatif', { durationS: 3600 })).resolves.toEqual({ ok: 1 });
    expect(seen?.method).toBe('POST');
    expect(seen?.body).toBe('{"durationS":3600}');
  });
});
