import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthCard } from '../components/auth/AuthCard';
import { FormField } from '../components/auth/FormField';
import { AuthAlert, type AuthAlertVariant } from '../components/auth/AuthAlert';

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [submitStatus, setSubmitStatus] = useState<{
    variant: AuthAlertVariant;
    title?: string;
    message: string;
    retryAfterSeconds?: number;
  } | null>(() => {
    // Check if simulate query param was passed for testing UI states
    const queryState = searchParams.get('state');
    if (queryState === '429' || queryState === 'rate_limit') {
      return {
        variant: 'rate_limit',
        title: 'Too Many Requests (429)',
        message: 'Too many login attempts. Please wait before attempting to sign in again.',
        retryAfterSeconds: 60,
      };
    }
    if (queryState === '503' || queryState === 'service_unavailable') {
      return {
        variant: 'unavailable',
        title: 'Service Unavailable (503)',
        message: 'The authentication service is temporarily unavailable. Please try again later.',
      };
    }
    if (queryState === 'offline') {
      return {
        variant: 'offline',
        title: 'Network Offline',
        message: 'Unable to connect to the authentication server. Please check your internet connection.',
      };
    }
    return null;
  });

  const validate = (): boolean => {
    const newErrors: { email?: string; password?: string } = {};

    if (!email.trim()) {
      newErrors.email = 'Email address is required.';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      newErrors.email = 'Please enter a valid email address.';
    }

    if (!password) {
      newErrors.password = 'Password is required.';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) {
      return;
    }

    // Honest Phase 2 UI Shell notice — no fake authentication, no token storage
    setSubmitStatus({
      variant: 'unavailable',
      title: 'Authentication Service Unavailable',
      message:
        'Authentication backend service is not yet deployed (Phase 2 UI Shell). Real credential verification and session tokens will be connected in future tasks. No user account was signed in.',
    });
  };

  return (
    <AuthCard
      title="Sign in to Roundset"
      subtitle="Enter your email and password to access your candidate account"
      footer={
        <div>
          <span>Don&apos;t have an account? </span>
          <Link
            to="/register"
            className="font-semibold text-[#2563EB] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded"
          >
            Create an account
          </Link>
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
          id="login-email"
          name="email"
          label="Email address"
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

        <FormField
          id="login-password"
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }));
          }}
          error={errors.password}
          placeholder="••••••••"
          rightAction={
            <Link
              to="/forgot-password"
              className="text-xs text-[#2563EB] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded"
            >
              Forgot password?
            </Link>
          }
        />

        <button
          type="submit"
          className="w-full py-2.5 px-4 bg-[#2563EB] hover:bg-blue-700 text-white text-sm font-semibold rounded-lg shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 cursor-pointer"
        >
          Sign In
        </button>
      </form>
    </AuthCard>
  );
}
