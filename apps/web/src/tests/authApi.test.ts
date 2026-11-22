// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAuthMeta, type AuthMetaData } from '../lib/api';

describe('fetchAuthMeta API client', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns success when /auth/meta responds with 200 and valid schema', async () => {
    const mockData: AuthMetaData = {
      activePolicyId: 'roundset-terms-v1',
      activeConsentVersion: '2026-11-v1',
      registrationMode: 'PUBLIC',
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        data: mockData,
        meta: { requestId: 'req-auth-123' },
      }),
    } as unknown as Response);

    const result = await fetchAuthMeta();
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.data.activePolicyId).toBe('roundset-terms-v1');
      expect(result.data.activeConsentVersion).toBe('2026-11-v1');
      expect(result.data.registrationMode).toBe('PUBLIC');
      expect(result.meta?.requestId).toBe('req-auth-123');
    }
  });

  it('returns unavailable when /auth/meta returns 503 or 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 503,
      json: async () => ({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Down' } }),
    } as unknown as Response);

    const result = await fetchAuthMeta();
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.status).toBe(503);
    }
  });

  it('returns invalid when /auth/meta returns invalid schema or malformed JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        data: {
          activePolicyId: 123, // invalid type
        },
      }),
    } as unknown as Response);

    const result = await fetchAuthMeta();
    expect(result.kind).toBe('invalid');
  });

  it('returns offline when network is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await fetchAuthMeta();
    expect(result.kind).toBe('offline');
  });

  it('returns aborted when external signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await fetchAuthMeta({ signal: controller.signal });
    expect(result.kind).toBe('aborted');
  });
});
