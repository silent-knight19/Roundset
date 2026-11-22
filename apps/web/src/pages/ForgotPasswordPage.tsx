import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthCard } from '../components/auth/AuthCard';
import { FormField } from '../components/auth/FormField';
import { AuthAlert, type AuthAlertVariant } from '../components/auth/AuthAlert';

export function ForgotPasswordPage() {
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [submitStatus, setSubmitStatus] = useState<{
    variant: AuthAlertVariant;
    title?: string;
    message: string;
    retryAfterSeconds?: number;
  } | null>(() => {
    const queryState = searchParams.get('state');
    if (queryState === '429' || queryState === 'rate_limit') {
      return {
        variant: 'rate_limit',
        title: 'Too Many Recovery Requests (429)',
        message: 'Password recovery rate limit exceeded. Please wait before requesting another code.',
        retryAfterSeconds: 60,
      };
    }
    if (queryState === '503' || queryState === 'service_unavailable') {
      return {
        variant: 'unavailable',
        title: 'Service Unavailable (503)',
        message: 'Password recovery service is temporarily unavailable. Please try again later.',
      };
    }
    if (queryState === 'offline') {
      return {
        variant: 'offline',
        title: 'Network Offline',
        message: 'Unable to connect to the recovery server. Please check your internet connection.',
      };
    }
    return null;
  });

  const validate = (): boolean => {
    if (!email.trim()) {
      setEmailError('Email address is required.');
      return false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setEmailError('Please enter a valid email address.');
      return false;
    }
    setEmailError(undefined);
    return true;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) {
      return;
    }

    // Honest Phase 2 UI Shell notice — no fake recovery dispatch
    setSubmitStatus({
      variant: 'unavailable',
      title: 'Password Recovery Unavailable',
      message:
        'Password recovery backend service is not yet deployed (Phase 2 UI Shell). Recovery challenge generation and email dispatch will be connected in future tasks. No email was sent.',
    });
  };

  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter your account email to receive a secure recovery code"
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
              to="/reset-password"
              className="text-slate-500 hover:text-slate-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded"
            >
              Already have a recovery code? Reset password
            </Link>
          </div>
        </div>
      }
    >
      {/* Account-Independent Privacy / Anti-Enumeration Notice */}
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-600 leading-relaxed">
        <span className="font-semibold text-slate-700">Account Privacy Note: </span>
        To protect candidate privacy and prevent user enumeration, recovery requests return an identical generic confirmation regardless of whether the email is registered.
      </div>

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
          id="forgot-email"
          name="email"
          label="Account email address"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (emailError) setEmailError(undefined);
          }}
          error={emailError}
          placeholder="candidate@example.com"
          helperText="We will send a 6-digit recovery code if an active account is associated with this address."
        />

        <button
          type="submit"
          className="w-full py-2.5 px-4 bg-[#2563EB] hover:bg-blue-700 text-white text-sm font-semibold rounded-lg shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 cursor-pointer"
        >
          Send Recovery Code
        </button>
      </form>
    </AuthCard>
  );
}
