// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import { HealthStatus } from '../components/HealthStatus';

describe('HealthStatus Component', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('shows checking state initially', () => {
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));

    render(<HealthStatus />);

    const checkingElements = screen.getAllByText(/Checking connection/i);
    expect(checkingElements.length).toBeGreaterThan(0);
  });

  it('shows backend online and backend ready on successful responses', async () => {
    globalThis.fetch = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/health/live')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: { status: 'ok', version: '0.1.0' },
              meta: { requestId: 'req_live_123' },
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        );
      }
      if (url.includes('/api/v1/health/ready')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: { ready: true },
              meta: { requestId: 'req_ready_123' },
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        );
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    render(<HealthStatus />);

    await waitFor(() => {
      expect(screen.getByText('Backend online')).toBeTruthy();
      expect(screen.getByText('Backend ready')).toBeTruthy();
      expect(screen.getByText('0.1.0')).toBeTruthy();
    });
  });

  it('shows backend online but not ready on HTTP 503 readiness response', async () => {
    globalThis.fetch = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/health/live')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: { status: 'ok', version: '0.1.0' },
              meta: { requestId: 'req_live_ok' },
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        );
      }
      if (url.includes('/api/v1/health/ready')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: { ready: false },
              meta: { requestId: 'req_ready_503' },
            }),
            {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        );
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    render(<HealthStatus />);

    await waitFor(() => {
      expect(screen.getByText('Backend online')).toBeTruthy();
      expect(screen.getByText('Backend not ready')).toBeTruthy();
      expect(
        screen.getByText(/HTTP 503 received: Server is running but required dependencies/i),
      ).toBeTruthy();
    });
  });

  it('rejects contradictory readiness (HTTP 200 with ready: false) and displays invalid state', async () => {
    globalThis.fetch = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/health/live')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: { status: 'ok', version: '0.1.0' },
              meta: { requestId: 'req_live_ok' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.includes('/api/v1/health/ready')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: { ready: false },
              meta: { requestId: 'req_contradictory_200' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    render(<HealthStatus />);

    await waitFor(() => {
      expect(screen.getByText('Backend online')).toBeTruthy();
      expect(screen.getByText('Invalid API response')).toBeTruthy();
      expect(
        screen.getByText(/Contradictory readiness response: HTTP 200 returned ready: false/i),
      ).toBeTruthy();
    });
  });

  it('rejects contradictory readiness (HTTP 503 with ready: true) and displays invalid state', async () => {
    globalThis.fetch = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/health/live')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: { status: 'ok', version: '0.1.0' },
              meta: { requestId: 'req_live_ok' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.includes('/api/v1/health/ready')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: { ready: true },
              meta: { requestId: 'req_contradictory_503' },
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    render(<HealthStatus />);

    await waitFor(() => {
      expect(screen.getByText('Backend online')).toBeTruthy();
      expect(screen.getByText('Invalid API response')).toBeTruthy();
      expect(
        screen.getByText(/Contradictory readiness response: HTTP 503 returned ready: true/i),
      ).toBeTruthy();
    });
  });

  it('shows backend unavailable on health endpoint HTTP 500 error', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'Internal Server Error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    render(<HealthStatus />);

    await waitFor(() => {
      const unavailableBadges = screen.getAllByText('Backend unavailable');
      expect(unavailableBadges.length).toBeGreaterThan(0);
      const http500Elements = screen.getAllByText(/HTTP 500/i);
      expect(http500Elements.length).toBeGreaterThan(0);
    });
  });

  it('shows backend unavailable on Vite proxy HTTP 502 error', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve(
        new Response('', {
          status: 502,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );
    });

    render(<HealthStatus />);

    await waitFor(() => {
      const unavailableBadges = screen.getAllByText('Backend unavailable');
      expect(unavailableBadges.length).toBeGreaterThan(0);
      const http502Elements = screen.getAllByText(/HTTP 502/i);
      expect(http502Elements.length).toBeGreaterThan(0);
    });
  });

  it('shows backend offline when network fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    render(<HealthStatus />);

    await waitFor(() => {
      const offlineBadges = screen.getAllByText('Backend offline');
      expect(offlineBadges.length).toBeGreaterThan(0);
      const errorDetails = screen.getAllByText(/Failed to fetch/i);
      expect(errorDetails.length).toBeGreaterThan(0);
    });
  });

  it('displays a controlled failure state on malformed API JSON', async () => {
    globalThis.fetch = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/health/live')) {
        return Promise.resolve(
          new Response('{"data":{"status":"invalid_status"}}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response('not-even-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    render(<HealthStatus />);

    await waitFor(() => {
      const invalidBadges = screen.getAllByText('Invalid API response');
      expect(invalidBadges.length).toBeGreaterThan(0);
    });
  });

  it('asserts five-second deadline expiry displays Request timeout using fake timers', async () => {
    vi.useFakeTimers();

    globalThis.fetch = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
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
      });
    });

    render(<HealthStatus />);

    // Fast-forward past the 5-second deadline
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });

    const timeoutBadges = screen.getAllByText('Request timeout');
    expect(timeoutBadges.length).toBeGreaterThan(0);

    vi.useRealTimers();
  });

  it('triggers a fresh check when Refresh Status button is clicked', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: { status: 'ok', version: '0.1.0' },
            meta: { requestId: `req_${callCount}` },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });

    render(<HealthStatus />);

    await waitFor(() => {
      expect(callCount).toBeGreaterThanOrEqual(2); // live + ready
      expect(screen.getByRole('button', { name: /Refresh Status/i })).toBeTruthy();
    });

    const initialCalls = callCount;
    const refreshButton = screen.getByRole('button', { name: /Refresh Status/i });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(callCount).toBeGreaterThan(initialCalls);
    });
  });

  it('cleans up on unmount without producing stale updates', () => {
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));

    const { unmount } = render(<HealthStatus />);
    expect(() => unmount()).not.toThrow();
  });
});
