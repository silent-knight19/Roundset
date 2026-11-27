// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAuthMeta,
  refreshSession,
  logoutSession,
  logoutAllSessions,
} from '../lib/auth/authClient';
import {
  readCsrfCookie,
  parseDocumentCookies,
  PROD_CSRF_COOKIE_NAME,
  DEV_CSRF_COOKIE_NAME,
} from '../lib/auth/cookies';

const VALID_REQUEST_ID = '00000000-0000-4000-8000-000000000001';

function buildValidSessionResponse(accessToken = 'jwt.access.token') {
  return {
    data: {
      accessToken,
      tokenType: 'Bearer' as const,
      expiresInSeconds: 600,
      user: {
        id: '507f1f77bcf86cd799439011',
        email: 'candidate@example.test',
        emailVerified: true,
        displayName: 'Test Candidate',
        role: 'CANDIDATE' as const,
        accountStatus: 'ACTIVE' as const,
      },
      session: {
        id: 'sess-123',
        expiresAt: '2026-12-22T16:00:00.000Z',
      },
    },
    meta: { requestId: VALID_REQUEST_ID },
  };
}

describe('Auth Client & CSRF Cookie Helpers (P2-FE-02)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    document.cookie = `${DEV_CSRF_COOKIE_NAME}=; Max-Age=0; Path=/`;
    document.cookie = `${PROD_CSRF_COOKIE_NAME}=; Max-Age=0; Path=/`;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  describe('CSRF cookie parsing and reading', () => {
    it('parses cookie pairs including encoded values and ignores refresh cookies', () => {
      const parsed = parseDocumentCookies(
        'roundset_csrf=c1.k1.s1.n1.mac%3D1; other=val',
      );
      expect(parsed[DEV_CSRF_COOKIE_NAME]).toBe('c1.k1.s1.n1.mac=1');
      expect(parsed.other).toBe('val');
    });

    it('reads dev CSRF cookie on HTTP loopback and sends exact value in X-CSRF-Token', async () => {
      document.cookie = `${DEV_CSRF_COOKIE_NAME}=c1.dev.token; Path=/`;
      expect(readCsrfCookie()).toBe('c1.dev.token');

      const fetchMock = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => buildValidSessionResponse(),
      } as unknown as Response);
      globalThis.fetch = fetchMock;

      const result = await refreshSession();
      expect(result.kind).toBe('authenticated');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/v1/auth/refresh');
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('same-origin');
      expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe(
        'c1.dev.token',
      );
      expect(init.body).toBe('{}');
    });

    it('prefers __Host-roundset_csrf when present', () => {
      const cookieSpy = vi
        .spyOn(document, 'cookie', 'get')
        .mockReturnValue(
          `${DEV_CSRF_COOKIE_NAME}=c1.dev; ${PROD_CSRF_COOKIE_NAME}=c1.prod`,
        );
      expect(readCsrfCookie()).toBe('c1.prod');
      cookieSpy.mockRestore();
    });
  });

  describe('refreshSession outcomes', () => {
    it('returns authenticated on valid 200 SessionResponse', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => buildValidSessionResponse('ey.valid.jwt'),
      } as unknown as Response);

      const res = await refreshSession();
      expect(res.kind).toBe('authenticated');
      if (res.kind === 'authenticated') {
        expect(res.data.accessToken).toBe('ey.valid.jwt');
        expect(res.data.user.email).toBe('candidate@example.test');
      }
    });

    it('returns unauthenticated on 401 AUTH_REQUIRED', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 401,
        json: async () => ({
          error: {
            code: 'AUTH_REQUIRED',
            message: 'Refresh token is required',
            requestId: VALID_REQUEST_ID,
          },
        }),
      } as unknown as Response);

      const res = await refreshSession();
      expect(res.kind).toBe('unauthenticated');
    });

    it('returns replay_detected on 401 SESSION_REPLAY_DETECTED', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 401,
        json: async () => ({
          error: {
            code: 'SESSION_REPLAY_DETECTED',
            message: 'Session replay detected',
            requestId: VALID_REQUEST_ID,
          },
        }),
      } as unknown as Response);

      const res = await refreshSession();
      expect(res.kind).toBe('replay_detected');
    });

    it('rejects malformed 200 schema and JSON parse errors without authenticating', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ data: { accessToken: 123 }, meta: {} }),
      } as unknown as Response);

      const badSchema = await refreshSession();
      expect(badSchema.kind).toBe('invalid');

      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      } as unknown as Response);

      const badJson = await refreshSession();
      expect(badJson.kind).toBe('uncertain');
      if (badJson.kind === 'uncertain') {
        expect(badJson.reason).toBe('malformed');
      }
    });

    it('returns uncertain on network error and timeout (no automatic retry)', async () => {
      const netFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      globalThis.fetch = netFetch;

      const netRes = await refreshSession();
      expect(netRes.kind).toBe('uncertain');
      if (netRes.kind === 'uncertain') {
        expect(netRes.reason).toBe('network');
      }
      expect(netFetch).toHaveBeenCalledTimes(1);

      vi.useFakeTimers();
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      );

      const timeoutPromise = refreshSession({ timeoutMs: 250 });
      await vi.advanceTimersByTimeAsync(260);
      const timeoutRes = await timeoutPromise;
      expect(timeoutRes.kind).toBe('uncertain');
      if (timeoutRes.kind === 'uncertain') {
        expect(timeoutRes.reason).toBe('timeout');
      }
    });

    it('returns aborted when external AbortSignal aborts', async () => {
      const ac = new AbortController();
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      );

      const promise = refreshSession({ signal: ac.signal });
      ac.abort();
      const res = await promise;
      expect(res.kind).toBe('aborted');
    });
  });

  describe('logout, logout-all, and auth/meta', () => {
    it('sends CSRF and Bearer on logout and handles 204 vs 403 mismatch', async () => {
      document.cookie = `${DEV_CSRF_COOKIE_NAME}=c1.logout.csrf; Path=/`;
      const fetchMock = vi.fn().mockResolvedValue({
        status: 204,
      } as unknown as Response);
      globalThis.fetch = fetchMock;

      const okRes = await logoutSession({ accessToken: 'ey.access' });
      expect(okRes.kind).toBe('logged_out');
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe(
        'c1.logout.csrf',
      );
      expect((init.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer ey.access',
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 403,
        json: async () => ({
          error: {
            code: 'FORBIDDEN',
            message: 'Logout credential and session mismatch',
            requestId: VALID_REQUEST_ID,
          },
        }),
      } as unknown as Response);

      const mismatchRes = await logoutSession({ accessToken: 'ey.other' });
      expect(mismatchRes.kind).toBe('mismatch');
    });

    it('sends Bearer on logout-all and handles 204', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        status: 204,
      } as unknown as Response);
      globalThis.fetch = fetchMock;

      const res = await logoutAllSessions({ accessToken: 'ey.access' });
      expect(res.kind).toBe('logged_out_all');
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/v1/auth/logout-all');
      expect((init.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer ey.access',
      );
    });

    it('validates GET /api/v1/auth/meta with AuthMetaResponseSchema and handles abort', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          data: {
            activePolicyId: 'roundset-terms-v1',
            activeConsentVersion: '2026-11-v1',
            registrationMode: 'PUBLIC',
          },
          meta: { requestId: VALID_REQUEST_ID },
        }),
      } as unknown as Response);

      const ok = await getAuthMeta();
      expect(ok.kind).toBe('success');

      const ac = new AbortController();
      ac.abort();
      const aborted = await getAuthMeta({ signal: ac.signal });
      expect(aborted.kind).toBe('aborted');
    });
  });
});
