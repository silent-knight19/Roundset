// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { HealthStatus } from '../components/HealthStatus';

describe('HealthStatus Component', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it('shows checking state initially', () => {
    // Hang fetch so checking state is displayed
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

  it('handles slow/timed out requests without crashing and cleans up on unmount', async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            const err = new Error('REQUEST_TIMEOUT');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    const { unmount } = render(<HealthStatus />);

    expect(() => unmount()).not.toThrow();
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
    });

    const initialCalls = callCount;
    const refreshButton = screen.getByRole('button', { name: /Refresh Status/i });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(callCount).toBeGreaterThan(initialCalls);
    });
  });
});
