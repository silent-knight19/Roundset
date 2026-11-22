// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { createMemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { routes } from '../app/router';

describe('App and Navigation Tests', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it('renders home page without backend availability', async () => {
    // Network completely down
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const testRouter = createMemoryRouter(routes, { initialEntries: ['/'] });
    render(<App router={testRouter} />);

    // Brand and hero are rendered
    expect(screen.getByRole('heading', { name: /Roundset AI Interviewer/i })).toBeTruthy();
    expect(screen.getAllByText(/Ellis/i).length).toBeGreaterThan(0);

    // Health card renders controlled offline state without throwing
    await waitFor(() => {
      const offlineBadges = screen.getAllByText('Backend offline');
      expect(offlineBadges.length).toBeGreaterThan(0);
    });
  });

  it('exposes all four approved public routes in navigation', () => {
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    const testRouter = createMemoryRouter(routes, { initialEntries: ['/'] });
    render(<App router={testRouter} />);

    const primaryNav = screen.getByRole('navigation', { name: /Primary/i });
    expect(primaryNav).toBeTruthy();

    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Interview' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Pricing' })).toBeTruthy();
  });

  it('shows an accessible not-found state for unknown routes', () => {
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    const testRouter = createMemoryRouter(routes, {
      initialEntries: ['/completely-unknown-route'],
    });
    render(<App router={testRouter} />);

    expect(screen.getByRole('heading', { name: /Page Not Found/i })).toBeTruthy();
    expect(screen.getByText(/404/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Return to Home/i })).toBeTruthy();
  });

  it('ensures no actual admin access is available', () => {
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));

    // 1. Check navigation placeholder is non-interactive
    const homeRouter = createMemoryRouter(routes, { initialEntries: ['/'] });
    const { unmount } = render(<App router={homeRouter} />);

    const adminPlaceholder = screen.getByText(/Admin \(Disabled\)/i);
    expect(adminPlaceholder.getAttribute('aria-disabled')).toBe('true');
    expect(adminPlaceholder.tagName.toLowerCase()).not.toBe('a');
    unmount();

    // 2. Direct navigation to /admin displays 404 Not Found
    const adminRouter = createMemoryRouter(routes, { initialEntries: ['/admin'] });
    render(<App router={adminRouter} />);

    expect(screen.getByRole('heading', { name: /Page Not Found/i })).toBeTruthy();
    expect(
      screen.getByText(/no administrative interface is accessible without verified authentication/i),
    ).toBeTruthy();
  });

  it('navigates to interview placeholder with inactive status', () => {
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    const testRouter = createMemoryRouter(routes, { initialEntries: ['/interview'] });
    render(<App router={testRouter} />);

    expect(screen.getByRole('heading', { name: /Interview Session/i })).toBeTruthy();
    expect(screen.getByText(/Not Yet Implemented \(Phase 4 & 5\)/i)).toBeTruthy();
    expect(screen.getByText(/No mock interview session is simulated/i)).toBeTruthy();
  });

  it('navigates to dashboard placeholder with inactive status', () => {
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    const testRouter = createMemoryRouter(routes, { initialEntries: ['/dashboard'] });
    render(<App router={testRouter} />);

    expect(screen.getByRole('heading', { name: /Candidate Dashboard/i })).toBeTruthy();
    expect(screen.getByText(/Not Yet Implemented \(Phase 2 & 3\)/i)).toBeTruthy();
    expect(screen.getByText(/No fake accounts or simulated metrics/i)).toBeTruthy();
  });

  it('navigates to pricing placeholder with inactive status', () => {
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    const testRouter = createMemoryRouter(routes, { initialEntries: ['/pricing'] });
    render(<App router={testRouter} />);

    expect(screen.getByRole('heading', { name: /Plans & Pricing Catalog/i })).toBeTruthy();
    expect(screen.getByText(/Not Yet Implemented \(Phase 3 & 10\)/i)).toBeTruthy();
    expect(screen.getByText(/No mock checkout or payment processing/i)).toBeTruthy();
  });
});
