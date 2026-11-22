// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthAlert } from '../components/auth/AuthAlert';
import { AuthCard } from '../components/auth/AuthCard';
import { FormField } from '../components/auth/FormField';
import { OtpInputField } from '../components/auth/OtpInputField';

describe('Auth Reusable Components', () => {
  afterEach(() => {
    cleanup();
  });

  describe('AuthAlert accessibility and variants', () => {
    it('renders error alert with assertive role="alert"', () => {
      render(
        <AuthAlert
          variant="error"
          title="Authentication Failed"
          message="Invalid credentials entered."
        />,
      );

      const alert = screen.getByRole('alert');
      expect(alert).toBeTruthy();
      expect(alert.getAttribute('aria-live')).toBe('assertive');
      expect(screen.getByText('Authentication Failed')).toBeTruthy();
      expect(screen.getByText('Invalid credentials entered.')).toBeTruthy();
    });

    it('renders rate_limit alert with assertive role="alert" and retry timer', () => {
      render(
        <AuthAlert
          variant="rate_limit"
          title="Rate Limit Exceeded"
          message="Too many login attempts."
          retryAfterSeconds={45}
        />,
      );

      const alert = screen.getByRole('alert');
      expect(alert).toBeTruthy();
      expect(screen.getByText(/Retry after: 45 seconds/i)).toBeTruthy();
    });

    it('renders offline alert with assertive role="alert"', () => {
      render(
        <AuthAlert
          variant="offline"
          title="Network Offline"
          message="Cannot reach the server."
        />,
      );

      const alert = screen.getByRole('alert');
      expect(alert).toBeTruthy();
    });

    it('renders unavailable alert with polite role="status"', () => {
      render(
        <AuthAlert
          variant="unavailable"
          title="Service Unavailable"
          message="Authentication backend is not yet active."
        />,
      );

      const status = screen.getByRole('status');
      expect(status).toBeTruthy();
      expect(status.getAttribute('aria-live')).toBe('polite');
    });

    it('renders action button and calls callback when clicked', () => {
      const handleClick = vi.fn();
      render(
        <AuthAlert
          variant="warning"
          message="Context missing"
          action={{ label: 'Return Home', onClick: handleClick }}
        />,
      );

      const button = screen.getByRole('button', { name: 'Return Home' });
      fireEvent.click(button);
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('renders action link when href is supplied', () => {
      render(
        <AuthAlert
          variant="info"
          message="Check details"
          action={{ label: 'Documentation', href: '/docs' }}
        />,
      );

      const link = screen.getByRole('link', { name: 'Documentation' });
      expect(link.getAttribute('href')).toBe('/docs');
    });
  });

  describe('AuthCard component', () => {
    it('renders title, subtitle, children, and footer', () => {
      render(
        <MemoryRouter>
          <AuthCard
            title="Card Title"
            subtitle="Card Subtitle"
            footer={<span>Footer Link</span>}
          >
            <div>Form Body Content</div>
          </AuthCard>
        </MemoryRouter>,
      );

      expect(screen.getByRole('heading', { name: 'Card Title' })).toBeTruthy();
      expect(screen.getByText('Card Subtitle')).toBeTruthy();
      expect(screen.getByText('Form Body Content')).toBeTruthy();
      expect(screen.getByText('Footer Link')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Roundset Home' })).toBeTruthy();
    });
  });

  describe('FormField component', () => {
    it('renders label with accessible association to input', () => {
      const handleChange = vi.fn();
      render(
        <FormField
          id="test-input"
          name="test"
          label="Test Label"
          value=""
          onChange={handleChange}
          required
        />,
      );

      const input = screen.getByLabelText(/Test Label/);
      expect(input).toBeTruthy();
      expect(input.getAttribute('id')).toBe('test-input');
      expect(input.getAttribute('name')).toBe('test');
      expect(input.getAttribute('aria-invalid')).toBe('false');
    });

    it('displays error and sets aria-invalid and aria-describedby', () => {
      render(
        <FormField
          id="error-input"
          name="errorField"
          label="Error Field"
          value="invalid"
          onChange={() => {}}
          error="Value is invalid"
        />,
      );

      const input = screen.getByLabelText(/Error Field/);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')).toBe('error-input-error');

      const errorMsg = screen.getByRole('alert');
      expect(errorMsg.textContent).toBe('Value is invalid');
      expect(errorMsg.id).toBe('error-input-error');
    });
  });

  describe('OtpInputField component', () => {
    it('restricts input to numeric digits only and enforces maxLength', () => {
      let otpVal = '';
      const setVal = vi.fn((val) => {
        otpVal = val;
      });

      const { rerender } = render(
        <OtpInputField
          id="otp-field"
          label="Verification Code"
          value={otpVal}
          onChange={setVal}
        />,
      );

      const input = screen.getByLabelText(/Verification Code/) as HTMLInputElement;
      expect(input.getAttribute('inputmode')).toBe('numeric');
      expect(input.getAttribute('maxlength')).toBe('6');

      // Enter digits
      fireEvent.change(input, { target: { value: '12a3b4c5' } });
      expect(setVal).toHaveBeenCalledWith('12345');

      rerender(
        <OtpInputField
          id="otp-field"
          label="Verification Code"
          value="123456"
          onChange={setVal}
        />,
      );
      expect(input.value).toBe('123456');
    });

    it('presents accessible error message when invalid', () => {
      render(
        <OtpInputField
          id="otp-error"
          label="OTP Code"
          value="12"
          onChange={() => {}}
          error="Must be 6 digits"
        />,
      );

      const input = screen.getByLabelText(/OTP Code/);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByRole('alert').textContent).toBe('Must be 6 digits');
    });
  });
});
