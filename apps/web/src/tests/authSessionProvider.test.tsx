// @vitest-environment jsdom
import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { createMemoryRouter } from 'react-router-dom';
import { AuthProvider, useAuth } from '../app/AuthContext';
import { App } from '../App';
import { routes } from '../app/router';
import { SessionCoordinator } from '../lib/auth/sessionCoordinator';
import { DEV_CSRF_COOKIE_NAME } from '../lib/auth/cookies';

const VALID_REQUEST_ID = '00000000-0000-4000-8000-000000000099';

function makeSessionPayload(accessToken = 'ey.memory.only.jwt', sessionId = 'sess-1') {
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
        id: sessionId,
        expiresAt: '2026-12-22T16:00:00.000Z',
      },
    },
    meta: { requestId: VALID_REQUEST_ID },
  };
}

function AuthProbe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="auth-status">{auth.status}</span>
      <span data-testid="auth-reason">{auth.reloginReason ?? 'none'}</span>
      <span data-testid="auth-user">{auth.user?.email ?? 'none'}</span>
      <span data-testid="auth-token">{auth.getAccessToken() ?? 'null'}</span>
      <button type="button" onClick={() => void auth.refresh()}>
        Refresh
      </button>
      <button type="button" onClick={() => void auth.logout()}>
        Logout
      </button>
      <button type="button" onClick={() => void auth.logoutAll()}>
        LogoutAll
      </button>
    </div>
  );
}

describe('AuthProvider, SessionCoordinator & Multi-Tab Sync (P2-FE-02)', () => {
  const originalFetch = globalThis.fetch;
  const originalLocks = navigator.locks;
  const originalBroadcastChannel = globalThis.BroadcastChannel;

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    document.cookie = `${DEV_CSRF_COOKIE_NAME}=; Max-Age=0; Path=/`;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    Object.defineProperty(navigator, 'locks', {
      value: originalLocks,
      configurable: true,
    });
    globalThis.BroadcastChannel = originalBroadcastChannel;
    localStorage.clear();
    sessionStorage.clear();
  });

  it('restores session in memory only and writes zero persistent credentials', async () => {
    document.cookie = `${DEV_CSRF_COOKIE_NAME}=c1.boot; Path=/`;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => makeSessionPayload('ey.mem.jwt'),
    } as unknown as Response);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-status').textContent).toBe('authenticated');
    });
    expect(screen.getByTestId('auth-user').textContent).toBe('candidate@example.test');
    expect(screen.getByTestId('auth-token').textContent).toBe('ey.mem.jwt');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain('ey.mem.jwt');
  });

  it('coalesces concurrent in-tab refresh calls into a single network request', async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    globalThis.fetch = fetchMock;

    const coordinator = new SessionCoordinator();
    const p1 = coordinator.refresh();
    const p2 = coordinator.refresh();
    const p3 = coordinator.refresh();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch({
      status: 200,
      json: async () => makeSessionPayload('ey.coalesced'),
    } as unknown as Response);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.result.kind).toBe('authenticated');
    expect(r2.result.kind).toBe('authenticated');
    expect(r3.result.kind).toBe('authenticated');
  });

  it('coordinates across tabs with Web Locks (reading CSRF inside lock) and BroadcastChannel without leaking credentials', async () => {
    // Mock Web Locks to serialize lock callbacks in order
    let lockChain = Promise.resolve();
    const lockNames: string[] = [];
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: vi.fn((name: string, cb: () => Promise<unknown>) => {
          lockNames.push(name);
          const next = lockChain.then(() => cb());
          lockChain = next.then(
            () => undefined,
            () => undefined,
          );
          return next;
        }),
      },
    });

    // Mock BroadcastChannel bus
    const busMessages: unknown[] = [];
    const listeners = new Set<(ev: MessageEvent) => void>();
    class MockBroadcastChannel {
      public onmessage: ((ev: MessageEvent) => void) | null = null;
      private readonly handler = (ev: MessageEvent) => {
        this.onmessage?.(ev);
      };
      constructor(_name: string) {
        listeners.add(this.handler);
      }
      postMessage(data: unknown) {
        busMessages.push(data);
        for (const fn of listeners) {
          fn({ data } as MessageEvent);
        }
      }
      close() {
        listeners.delete(this.handler);
      }
    }
    globalThis.BroadcastChannel =
      MockBroadcastChannel as unknown as typeof BroadcastChannel;

    document.cookie = `${DEV_CSRF_COOKIE_NAME}=c1.initial; Path=/`;

    const seenCsrfHeaders: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenCsrfHeaders.push(headers['X-CSRF-Token'] ?? '');
      // Simulate server Set-Cookie updating CSRF cookie after first rotation
      document.cookie = `${DEV_CSRF_COOKIE_NAME}=c1.rotated; Path=/`;
      return {
        status: 200,
        json: async () => makeSessionPayload('ey.tab.token'),
      } as unknown as Response;
    });

    const tabA = new SessionCoordinator();
    const tabB = new SessionCoordinator();

    // Both tabs start refresh before rotation completes; Tab B must read c1.rotated inside lock
    const [resA, resB] = await Promise.all([tabA.refresh(), tabB.refresh()]);
    expect(resA.result.kind).toBe('authenticated');
    expect(resB.result.kind).toBe('authenticated');
    expect(lockNames).toEqual(['roundset:auth:refresh', 'roundset:auth:refresh']);
    expect(seenCsrfHeaders).toEqual(['c1.initial', 'c1.rotated']);

    // Logout in Tab A broadcasts to Tab B with zero credential material
    const onExternalLogoutB = vi.fn();
    tabB.attachCallbacks({
      onExternalLogout: onExternalLogoutB,
      onExternalInvalidation: vi.fn(),
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 204,
    } as unknown as Response);

    await tabA.logout({ accessToken: 'ey.tab.token' });
    expect(onExternalLogoutB).toHaveBeenCalledWith('logout');
    expect(JSON.stringify(busMessages)).not.toContain('ey.tab.token');
    expect(JSON.stringify(busMessages)).not.toContain('c1.');

    tabA.dispose();
    tabB.dispose();
  });

  it('prevents stale in-flight refresh from restoring a session after logout', async () => {
    let resolveRefresh!: (val: Response) => void;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/v1/auth/refresh') {
        return new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        });
      }
      return Promise.resolve({ status: 204 } as unknown as Response);
    });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    // Refresh is in flight; user logs out before refresh resolves
    await act(async () => {
      screen.getByRole('button', { name: 'Logout' }).click();
    });

    expect(screen.getByTestId('auth-status').textContent).toBe('unauthenticated');

    // Now the stale refresh resolves with 200
    await act(async () => {
      resolveRefresh({
        status: 200,
        json: async () => makeSessionPayload('ey.stale.should.not.restore'),
      } as unknown as Response);
    });

    expect(screen.getByTestId('auth-status').textContent).toBe('unauthenticated');
    expect(screen.getByTestId('auth-token').textContent).toBe('null');
  });

  it('handles SESSION_REPLAY_DETECTED and surfaces relogin alert on /login', async () => {
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

    const router = createMemoryRouter(routes, { initialEntries: ['/login'] });
    render(<App router={router} />);

    await waitFor(() => {
      expect(screen.getByText(/Session Revoked \(Replay Detected\)/i)).toBeTruthy();
    });
  });

  it('handles logout credential mismatch (403) honestly without clearing state silently', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/v1/auth/refresh') {
        return {
          status: 200,
          json: async () => makeSessionPayload('ey.active'),
        } as unknown as Response;
      }
      return {
        status: 403,
        json: async () => ({
          error: {
            code: 'FORBIDDEN',
            message: 'Logout credential and session mismatch',
            requestId: VALID_REQUEST_ID,
          },
        }),
      } as unknown as Response;
    });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-status').textContent).toBe('authenticated');
    });

    await act(async () => {
      screen.getByRole('button', { name: 'Logout' }).click();
    });

    expect(screen.getByTestId('auth-status').textContent).toBe('relogin_required');
    expect(screen.getByTestId('auth-reason').textContent).toBe('session_mismatch');
    expect(screen.getByTestId('auth-token').textContent).toBe('null');
  });

  it('restores session cleanly under React StrictMode with single-flight refresh', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => makeSessionPayload('ey.strictmode.jwt'),
    } as unknown as Response);
    globalThis.fetch = fetchMock;

    render(
      <StrictMode>
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-status').textContent).toBe('authenticated');
    });
    expect(screen.getByTestId('auth-token').textContent).toBe('ey.strictmode.jwt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
