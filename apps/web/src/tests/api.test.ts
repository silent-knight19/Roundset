import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchLiveness,
  fetchReadiness,
  fetchHealthOverview,
  DEFAULT_TIMEOUT_MS,
} from '../lib/api';

describe('API Client Unit Tests (lib/api.ts)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('rejects contradictory readiness: HTTP 200 with ready: false', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          data: { ready: false },
          meta: { requestId: 'req_contradictory_200' },
        }),
    } as Response);

    const result = await fetchReadiness();
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.error).toContain('Contradictory readiness response');
      expect(result.error).toContain('HTTP 200 returned ready: false');
    }
  });

  it('rejects contradictory readiness: HTTP 503 with ready: true', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 503,
      json: () =>
        Promise.resolve({
          data: { ready: true },
          meta: { requestId: 'req_contradictory_503' },
        }),
    } as Response);

    const result = await fetchReadiness();
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.error).toContain('Contradictory readiness response');
      expect(result.error).toContain('HTTP 503 returned ready: true');
    }
  });

  it('correctly classifies valid HTTP 503 with ready: false as not_ready', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 503,
      json: () =>
        Promise.resolve({
          data: { ready: false },
          meta: { requestId: 'req_valid_503' },
        }),
    } as Response);

    const result = await fetchReadiness();
    expect(result.kind).toBe('not_ready');
    if (result.kind === 'not_ready') {
      expect(result.data.ready).toBe(false);
      expect(result.meta.requestId).toBe('req_valid_503');
    }
  });

  it('correctly classifies valid HTTP 200 with ready: true as ready', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          data: { ready: true },
          meta: { requestId: 'req_valid_200' },
        }),
    } as Response);

    const result = await fetchReadiness();
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.data.ready).toBe(true);
      expect(result.meta.requestId).toBe('req_valid_200');
    }
  });

  it('classifies health endpoint HTTP 500 as controlled unavailable state', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 500,
      json: () => Promise.resolve({ error: 'Internal Server Error' }),
    } as Response);

    const livenessResult = await fetchLiveness();
    expect(livenessResult.kind).toBe('unavailable');
    if (livenessResult.kind === 'unavailable') {
      expect(livenessResult.status).toBe(500);
      expect(livenessResult.error).toContain('HTTP 500');
    }

    const readinessResult = await fetchReadiness();
    expect(readinessResult.kind).toBe('unavailable');
    if (readinessResult.kind === 'unavailable') {
      expect(readinessResult.status).toBe(500);
      expect(readinessResult.error).toContain('HTTP 500');
    }
  });

  it('classifies Vite proxy error HTTP 502 as controlled unavailable state', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 502,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    } as Response);

    const livenessResult = await fetchLiveness();
    expect(livenessResult.kind).toBe('unavailable');
    if (livenessResult.kind === 'unavailable') {
      expect(livenessResult.status).toBe(502);
      expect(livenessResult.error).toContain('HTTP 502');
    }

    const readinessResult = await fetchReadiness();
    expect(readinessResult.kind).toBe('unavailable');
    if (readinessResult.kind === 'unavailable') {
      expect(readinessResult.status).toBe(502);
      expect(readinessResult.error).toContain('HTTP 502');
    }
  });

  it('returns invalid on malformed JSON for HTTP 200 or 503', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token in JSON')),
    } as Response);

    const result = await fetchLiveness();
    expect(result.kind).toBe('invalid');
  });

  it('enforces deadline when response headers arrive but body consumption stalls', async () => {
    vi.useFakeTimers();

    // Headers resolve immediately, but body consumption stalls indefinitely
    globalThis.fetch = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      return Promise.resolve({
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            if (init?.signal?.aborted) {
              const err = new Error('REQUEST_TIMEOUT');
              err.name = 'AbortError';
              reject(err);
              return;
            }
            if (init?.signal) {
              init.signal.addEventListener('abort', () => {
                const err = new Error('REQUEST_TIMEOUT');
                err.name = 'AbortError';
                reject(err);
              });
            }
          }),
      } as unknown as Response);
    });

    const livenessPromise = fetchLiveness({ timeoutMs: DEFAULT_TIMEOUT_MS });

    // Advance time past the 5-second deadline
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + 100);

    const result = await livenessPromise;
    expect(result.kind).toBe('timeout');
    if (result.kind === 'timeout') {
      expect(result.error).toContain('Request timed out');
    }
  });

  it('returns aborted on external cancellation during pending body processing', async () => {
    const controller = new AbortController();

    globalThis.fetch = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      return Promise.resolve({
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            if (init?.signal?.aborted) {
              const err = new Error('USER_ABORT');
              err.name = 'AbortError';
              reject(err);
              return;
            }
            if (init?.signal) {
              init.signal.addEventListener('abort', () => {
                const err = new Error('USER_ABORT');
                err.name = 'AbortError';
                reject(err);
              });
            }
          }),
      } as unknown as Response);
    });

    const livenessPromise = fetchLiveness({ signal: controller.signal });

    // Allow microtasks to execute so fetch resolves and body consumption starts
    await Promise.resolve();

    // Cancel externally while body processing is pending
    controller.abort('User unmounted');

    const result = await livenessPromise;
    expect(result.kind).toBe('aborted');
  });

  it('fetchHealthOverview executes both liveness and readiness concurrently', async () => {
    globalThis.fetch = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/health/live')) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              data: { status: 'ok', version: '0.1.0' },
              meta: { requestId: 'live_req' },
            }),
        } as Response);
      }
      if (url.includes('/api/v1/health/ready')) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              data: { ready: true },
              meta: { requestId: 'ready_req' },
            }),
        } as Response);
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    const overview = await fetchHealthOverview();
    expect(overview.liveness.kind).toBe('online');
    expect(overview.readiness.kind).toBe('ready');
  });
});
