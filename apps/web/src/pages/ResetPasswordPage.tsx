import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthCard } from '../components/auth/AuthCard';
import { FormField } from '../components/auth/FormField';
import { OtpInputField } from '../components/auth/OtpInputField';
import { AuthAlert, type AuthAlertVariant } from '../components/auth/AuthAlert';
import { validateNewPassword } from '../lib/validation';

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState(() => searchParams.get('email') || '');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [errors, setErrors] = useState<{
    email?: string;
    code?: string;
    newPassword?: string;
    confirmPassword?: string;
  }>({});

  const [submitStatus, setSubmitStatus] = useState<{
    variant: AuthAlertVariant;
    title?: string;
    message: string;
    retryAfterSeconds?: number;
  } | null>(() => {
    const queryState = searchParams.get('state');
    if (queryState === 'expired_otp') {
      return {
        variant: 'error',
        title: 'Recovery Code Expired',
        message: 'The recovery code has expired (5-minute TTL). Please request a new recovery code.',
      };
    }
    if (queryState === 'invalid_otp') {
      return {
        variant: 'error',
        title: 'Invalid Recovery Code',
        message: 'The recovery code you entered is invalid. Please double check the code in your email.',
      };
    }
    if (queryState === '429' || queryState === 'rate_limit') {
      return {
        variant: 'rate_limit',
        title: 'Too Many Attempts (429)',
        message: 'Password reset rate limit exceeded. Please wait before attempting again.',
        retryAfterSeconds: 60,
      };
    }
    if (queryState === '503' || queryState === 'service_unavailable') {
      return {
        variant: 'unavailable',
        title: 'Service Unavailable (503)',
        message: 'Password reset service is temporarily unavailable. Please try again later.',
      };
    }
    if (queryState === 'offline') {
      return {
        variant: 'offline',
        title: 'Network Offline',
        message: 'Unable to connect to the password reset server. Please check your internet connection.',
      };
    }
    return null;
  });

  const validate = (): boolean => {
    const newErrors: {
      email?: string;
      code?: string;
      newPassword?: string;
      confirmPassword?: string;
    } = {};

    if (!email.trim()) {
      newErrors.email = 'Account email address is required.';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      newErrors.email = 'Please enter a valid email address.';
    }

    if (!code.trim()) {
      newErrors.code = '6-digit recovery code is required.';
    } else if (!/^\d{6}$/.test(code.trim())) {
      newErrors.code = 'Please enter a valid 6-digit recovery code.';
    }

    const passwordError = validateNewPassword(newPassword);
    if (passwordError) {
      newErrors.newPassword = passwordError;
    }

    if (!confirmPassword) {
      newErrors.confirmPassword = 'Password confirmation is required.';
    } else if (newPassword !== confirmPassword) {
      newErrors.confirmPassword = 'Passwords do not match.';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) {
      return;
    }

    // Honest Phase 2 UI Shell notice — no fake password change
    setSubmitStatus({
      variant: 'unavailable',
      title: 'Password Reset Unavailable',
      message:
        'Password reset backend service is not yet deployed (Phase 2 UI Shell). Recovery challenge verification and hash update will be connected in future tasks. No password was modified.',
    });
  };

  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter your recovery code and choose a new secure password"
      footer={
        <div className="space-y-1">
          <div>
            <span>Remember your password? </span>
            <Link
              to="/login"
              className="font-semibold text-[#2563EB] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded"
            >
              Sign in
            </Link>
          </div>
          <div>
            <Link
              to="/forgot-password"
              className="text-slate-500 hover:text-slate-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded"
            >
              Need a new code? Request recovery code
            </Link>
          </div>
        </div>
      }
    >
      {submitStatus && (
        <AuthAlert
          variant={submitStatus.variant}
          title={submitStatus.title}
          message={submitStatus.message}
          retryAfterSeconds={submitStatus.retryAfterSeconds}
        />
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <FormField
          id="reset-email"
          name="email"
          label="Account email address"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (errors.email) setErrors((prev) => ({ ...prev, email: undefined }));
          }}
          error={errors.email}
          placeholder="candidate@example.com"
        />

        <OtpInputField
          id="reset-code"
          name="code"
          label="6-Digit Recovery Code"
          value={code}
          onChange={(val) => {
            setCode(val);
            if (errors.code) setErrors((prev) => ({ ...prev, code: undefined }));
          }}
          error={errors.code}
          helperText="Enter the 6-digit code received from your password reset request."
        />

        <FormField
          id="reset-new-password"
          name="newPassword"
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          value={newPassword}
          onChange={(e) => {
            setNewPassword(e.target.value);
            if (errors.newPassword) setErrors((prev) => ({ ...prev, newPassword: undefined }));
            if (errors.confirmPassword && e.target.value === confirmPassword) {
              setErrors((prev) => ({ ...prev, confirmPassword: undefined }));
            }
          }}
          error={errors.newPassword}
          placeholder="••••••••"
          helperText="Must be 12–128 characters long."
        />

        <FormField
          id="reset-confirm-password"
          name="confirmPassword"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(e) => {
            setConfirmPassword(e.target.value);
            if (errors.confirmPassword) {
              setErrors((prev) => ({ ...prev, confirmPassword: undefined }));
            }
          }}
          error={errors.confirmPassword}
          placeholder="••••••••"
        />

        <button
          type="submit"
          className="w-full py-2.5 px-4 bg-[#2563EB] hover:bg-blue-700 text-white text-sm font-semibold rounded-lg shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 cursor-pointer"
        >
          Reset Password
        </button>
      </form>
    </AuthCard>
  );
}
