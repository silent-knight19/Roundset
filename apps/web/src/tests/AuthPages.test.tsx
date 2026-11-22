// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { routes } from '../app/router';

describe('Auth Pages and Flows (P2-FE-01)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('Route Rendering and Navigation', () => {
    it('renders login page at /login with accessible labels and links', () => {
      const router = createMemoryRouter(routes, { initialEntries: ['/login'] });
      render(<App router={router} />);

      expect(screen.getByRole('heading', { name: /Sign in to Roundset/i })).toBeTruthy();
      expect(screen.getByLabelText(/Email address/i)).toBeTruthy();
      expect(screen.getByLabelText(/Password/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Sign In/i })).toBeTruthy();
      expect(screen.getByRole('link', { name: /Create an account/i })).toBeTruthy();
      expect(screen.getByRole('link', { name: /Forgot password\?/i })).toBeTruthy();
    });

    it('renders register page at /register with policy discovery', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          data: {
            activePolicyId: 'roundset-terms-v1',
            activeConsentVersion: '2026-11-v1',
            registrationMode: 'PUBLIC',
          },
        }),
      } as unknown as Response);

      const router = createMemoryRouter(routes, { initialEntries: ['/register'] });
      render(<App router={router} />);

      expect(screen.getByRole('heading', { name: /Create your Roundset account/i })).toBeTruthy();
      expect(screen.getByLabelText(/Email address/i)).toBeTruthy();
      expect(screen.getByLabelText(/Display name/i)).toBeTruthy();
      expect(screen.getByLabelText(/Password/i)).toBeTruthy();

      await waitFor(() => {
        expect(
          screen.getByLabelText(/roundset-terms-v1, v2026-11-v1/i),
        ).toBeTruthy();
      });
      expect(screen.getByRole('button', { name: /Create Account/i })).toBeTruthy();
      expect(screen.getAllByRole('link', { name: /Sign in/i }).length).toBeGreaterThan(0);
    });

    it('renders verify email page at /verify-email and handles missing context safely', () => {
      const router = createMemoryRouter(routes, { initialEntries: ['/verify-email'] });
      render(<App router={router} />);

      expect(screen.getByRole('heading', { name: /Verify your email/i })).toBeTruthy();
      // Missing registration context warning
      expect(screen.getByText(/Missing Registration Context/i)).toBeTruthy();
      expect(screen.getByRole('link', { name: /Go to Registration/i })).toBeTruthy();
      expect(screen.getByLabelText(/6-Digit Verification Code/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Verify Email/i })).toBeTruthy();
      expect(screen.getByRole('button', { name: /Resend verification code/i })).toBeTruthy();
    });

    it('renders forgot password page at /forgot-password', () => {
      const router = createMemoryRouter(routes, { initialEntries: ['/forgot-password'] });
      render(<App router={router} />);

      expect(screen.getByRole('heading', { name: /Reset your password/i })).toBeTruthy();
      expect(screen.getByLabelText(/Account email address/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Send Recovery Code/i })).toBeTruthy();
      expect(screen.getByText(/Account Privacy Note/i)).toBeTruthy();
    });

    it('renders reset password page at /reset-password', () => {
      const router = createMemoryRouter(routes, { initialEntries: ['/reset-password'] });
      render(<App router={router} />);

      expect(screen.getByRole('heading', { name: /Reset your password/i })).toBeTruthy();
      expect(screen.getByLabelText(/Account email address/i)).toBeTruthy();
      expect(screen.getByLabelText(/6-Digit Recovery Code/i)).toBeTruthy();
      expect(screen.getByLabelText(/^New password/i)).toBeTruthy();
      expect(screen.getByLabelText(/Confirm new password/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Reset Password/i })).toBeTruthy();
    });
  });

  describe('Client-Side Validation and Error Handling', () => {
    it('validates required email and password on login submit', () => {
      const router = createMemoryRouter(routes, { initialEntries: ['/login'] });
      render(<App router={router} />);

      const submitBtn = screen.getByRole('button', { name: /Sign In/i });
      fireEvent.click(submitBtn);

      expect(screen.getByText('Email address is required.')).toBeTruthy();
      expect(screen.getByText('Password is required.')).toBeTruthy();

      // Enter invalid email format
      const emailInput = screen.getByLabelText(/Email address/i);
      fireEvent.change(emailInput, { target: { value: 'not-an-email' } });
      fireEvent.click(submitBtn);

      expect(screen.getByText('Please enter a valid email address.')).toBeTruthy();
    });

    it('validates password length and email on registration', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          data: {
            activePolicyId: 'roundset-terms-v1',
            activeConsentVersion: '2026-11-v1',
            registrationMode: 'PUBLIC',
          },
        }),
      } as unknown as Response);

      const router = createMemoryRouter(routes, { initialEntries: ['/register'] });
      render(<App router={router} />);

      await waitFor(() => {
        expect(screen.getByLabelText(/roundset-terms-v1/i)).toBeTruthy();
      });

      const emailInput = screen.getByLabelText(/Email address/i);
      const passwordInput = screen.getByLabelText(/^Password/i);
      const submitBtn = screen.getByRole('button', { name: /Create Account/i });

      // Password too short
      fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
      fireEvent.change(passwordInput, { target: { value: 'short' } });
      fireEvent.click(submitBtn);

      expect(screen.getByText('Password must be at least 8 characters long.')).toBeTruthy();
      expect(screen.getByText('You must agree to the policy terms to create an account.')).toBeTruthy();
    });

    it('rejects password confirmation mismatch on reset password', () => {
      const router = createMemoryRouter(routes, { initialEntries: ['/reset-password'] });
      render(<App router={router} />);

      const emailInput = screen.getByLabelText(/Account email address/i);
      const codeInput = screen.getByLabelText(/6-Digit Recovery Code/i);
      const newPasswordInput = screen.getByLabelText(/^New password/i);
      const confirmPasswordInput = screen.getByLabelText(/Confirm new password/i);
      const submitBtn = screen.getByRole('button', { name: /Reset Password/i });

      fireEvent.change(emailInput, { target: { value: 'candidate@example.com' } });
      fireEvent.change(codeInput, { target: { value: '123456' } });
      fireEvent.change(newPasswordInput, { target: { value: 'SecurePass123!' } });
      fireEvent.change(confirmPasswordInput, { target: { value: 'DifferentPass123!' } });
      fireEvent.click(submitBtn);

      expect(screen.getByText('Passwords do not match.')).toBeTruthy();
    });

    it('rejects non-6-digit OTP code on email verification', () => {
      const router = createMemoryRouter(routes, { initialEntries: ['/verify-email'] });
      render(<App router={router} />);

      const otpInput = screen.getByLabelText(/6-Digit Verification Code/i);
      const submitBtn = screen.getByRole('button', { name: /Verify Email/i });

      // Empty submission
      fireEvent.click(submitBtn);
      expect(screen.getByText('Verification code is required.')).toBeTruthy();

      // Enter only 3 digits
      fireEvent.change(otpInput, { target: { value: '123' } });
      fireEvent.click(submitBtn);
      expect(screen.getByText('Please enter a valid 6-digit verification code.')).toBeTruthy();
    });
  });

  describe('Policy Discovery Contract Enforcement', () => {
    it('blocks consent-dependent registration when /auth/meta is unavailable', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 503,
        json: async () => ({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Down' } }),
      } as unknown as Response);

      const router = createMemoryRouter(routes, { initialEntries: ['/register'] });
      render(<App router={router} />);

      await waitFor(() => {
        expect(screen.getByText(/Policy Discovery Unavailable/i)).toBeTruthy();
      });

      expect(
        screen.getByText(/Consent-dependent registration cannot proceed without an available current policy/i),
      ).toBeTruthy();

      const consentCheckbox = screen.getByRole('checkbox', { name: /I acknowledge and agree to the active terms/i });
      expect(consentCheckbox.hasAttribute('disabled')).toBe(true);

      const submitBtn = screen.getByRole('button', { name: /Create Account/i });
      expect(submitBtn.hasAttribute('disabled')).toBe(true);
    });

    it('displays invite-only notice when registrationMode is INVITE_ONLY', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          data: {
            activePolicyId: 'roundset-terms-invite',
            activeConsentVersion: '2026-11-invite',
            registrationMode: 'INVITE_ONLY',
          },
        }),
      } as unknown as Response);

      const router = createMemoryRouter(routes, { initialEntries: ['/register'] });
      render(<App router={router} />);

      await waitFor(() => {
        expect(screen.getByText(/Invite-Only Registration/i)).toBeTruthy();
      });
      expect(screen.getByText(/pre-approved email address/i)).toBeTruthy();
    });
  });

  describe('Registration Flow Context and Safe Handling', () => {
    it('displays target email when passed in navigation state', () => {
      const router = createMemoryRouter(routes, {
        initialEntries: [
          {
            pathname: '/verify-email',
            state: { email: 'applicant@example.com', registrationId: 'reg-xyz-987' },
          },
        ],
      });
      render(<App router={router} />);

      expect(screen.getByText('applicant@example.com')).toBeTruthy();
      expect(screen.getByText(/reg-xyz-987/)).toBeTruthy();
      expect(screen.queryByText(/Missing Registration Context/i)).toBeNull();
    });
  });

  describe('UI Error and Rate-Limit States', () => {
    it('displays accessible 429 rate limit state via state query param', () => {
      const router = createMemoryRouter(routes, {
        initialEntries: ['/login?state=429'],
      });
      render(<App router={router} />);

      const alert = screen.getByRole('alert');
      expect(alert).toBeTruthy();
      expect(screen.getByText(/Too Many Requests \(429\)/i)).toBeTruthy();
      expect(screen.getByText(/Retry after: 60 seconds/i)).toBeTruthy();
    });

    it('displays expired OTP state on /verify-email', () => {
      const router = createMemoryRouter(routes, {
        initialEntries: ['/verify-email?state=expired_otp'],
      });
      render(<App router={router} />);

      const alert = screen.getByRole('alert');
      expect(alert).toBeTruthy();
      expect(screen.getByText(/Verification Code Expired/i)).toBeTruthy();
    });

    it('displays network offline state on /forgot-password', () => {
      const router = createMemoryRouter(routes, {
        initialEntries: ['/forgot-password?state=offline'],
      });
      render(<App router={router} />);

      const alert = screen.getByRole('alert');
      expect(alert).toBeTruthy();
      expect(screen.getByText(/Network Offline/i)).toBeTruthy();
    });
  });

  describe('No Fake Authentication or Token Persistence', () => {
    it('submitting valid login form displays honest unavailable state and does not store tokens', async () => {
      const router = createMemoryRouter(routes, { initialEntries: ['/login'] });
      render(<App router={router} />);

      fireEvent.change(screen.getByLabelText(/Email address/i), {
        target: { value: 'candidate@example.com' },
      });
      fireEvent.change(screen.getByLabelText(/Password/i), {
        target: { value: 'ValidPassword123!' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Sign In/i }));

      expect(
        screen.getByRole('heading', { name: /Authentication Service Unavailable/i }),
      ).toBeTruthy();
      expect(screen.getByText(/No user account was signed in/i)).toBeTruthy();

      // Crucial requirement: No storage pollution
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });

    it('submitting valid registration form displays honest unavailable state and does not create user', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          data: {
            activePolicyId: 'roundset-terms-v1',
            activeConsentVersion: '2026-11-v1',
            registrationMode: 'PUBLIC',
          },
        }),
      } as unknown as Response);

      const router = createMemoryRouter(routes, { initialEntries: ['/register'] });
      render(<App router={router} />);

      await waitFor(() => {
        expect(screen.getByLabelText(/roundset-terms-v1/i)).toBeTruthy();
      });

      fireEvent.change(screen.getByLabelText(/Email address/i), {
        target: { value: 'newuser@example.com' },
      });
      fireEvent.change(screen.getByLabelText(/^Password/i), {
        target: { value: 'StrongPassword123!' },
      });
      fireEvent.click(screen.getByLabelText(/roundset-terms-v1/i));
      fireEvent.click(screen.getByRole('button', { name: /Create Account/i }));

      expect(
        screen.getByRole('heading', { name: /Registration Service Unavailable/i }),
      ).toBeTruthy();
      expect(screen.getByText(/No user account was created/i)).toBeTruthy();

      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });

    it('submitting valid verify email form displays honest unavailable status', () => {
      const router = createMemoryRouter(routes, {
        initialEntries: [
          {
            pathname: '/verify-email',
            state: { email: 'user@example.com', registrationId: 'reg-123' },
          },
        ],
      });
      render(<App router={router} />);

      fireEvent.change(screen.getByLabelText(/6-Digit Verification Code/i), {
        target: { value: '123456' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Verify Email/i }));

      expect(
        screen.getByRole('heading', { name: /Verification Service Unavailable/i }),
      ).toBeTruthy();
      expect(screen.getByText(/No account was activated/i)).toBeTruthy();

      // Click resend button
      fireEvent.click(screen.getByRole('button', { name: /Resend verification code/i }));
      expect(
        screen.getByRole('heading', { name: /Resend Service Unavailable/i }),
      ).toBeTruthy();

      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });

    it('submitting forgot password displays honest unavailable status', () => {
      const router = createMemoryRouter(routes, { initialEntries: ['/forgot-password'] });
      render(<App router={router} />);

      fireEvent.change(screen.getByLabelText(/Account email address/i), {
        target: { value: 'someone@example.com' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Send Recovery Code/i }));

      expect(
        screen.getByRole('heading', { name: /Password Recovery Unavailable/i }),
      ).toBeTruthy();
      expect(screen.getByText(/No email was sent/i)).toBeTruthy();

      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });

    it('submitting reset password displays honest unavailable status', () => {
      const router = createMemoryRouter(routes, { initialEntries: ['/reset-password'] });
      render(<App router={router} />);

      fireEvent.change(screen.getByLabelText(/Account email address/i), {
        target: { value: 'someone@example.com' },
      });
      fireEvent.change(screen.getByLabelText(/6-Digit Recovery Code/i), {
        target: { value: '654321' },
      });
      fireEvent.change(screen.getByLabelText(/^New password/i), {
        target: { value: 'BrandNewPass123!' },
      });
      fireEvent.change(screen.getByLabelText(/Confirm new password/i), {
        target: { value: 'BrandNewPass123!' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Reset Password/i }));

      expect(
        screen.getByRole('heading', { name: /Password Reset Unavailable/i }),
      ).toBeTruthy();
      expect(screen.getByText(/No password was modified/i)).toBeTruthy();

      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });
  });
});
