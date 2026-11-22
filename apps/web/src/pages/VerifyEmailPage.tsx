import React, { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { AuthCard } from '../components/auth/AuthCard';
import { OtpInputField } from '../components/auth/OtpInputField';
import { AuthAlert, type AuthAlertVariant } from '../components/auth/AuthAlert';

interface RegistrationContextState {
  email?: string;
  registrationId?: string;
}

export function VerifyEmailPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // Extract context from state or search params
  const stateContext = (location.state as RegistrationContextState) || {};
  const emailContext = (stateContext.email || searchParams.get('email') || '').trim();
  const registrationId = (stateContext.registrationId || searchParams.get('reg') || '').trim();

  // A nonempty registrationId is strictly required for valid registration context; email alone is insufficient.
  const hasRegistrationContext = Boolean(registrationId);

  const [otp, setOtp] = useState('');
  const [otpError, setOtpError] = useState<string | undefined>();
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
        title: 'Verification Code Expired',
        message: 'The 6-digit verification code has expired (5-minute TTL). Please request a new code.',
      };
    }
    if (queryState === 'invalid_otp') {
      return {
        variant: 'error',
        title: 'Invalid Verification Code',
        message: 'The verification code you entered is incorrect. Please check your email and try again.',
      };
    }
    if (queryState === '429' || queryState === 'rate_limit') {
      return {
        variant: 'rate_limit',
        title: 'Too Many Verification Attempts (429)',
        message: 'Verification rate limit exceeded. Please wait before attempting again.',
        retryAfterSeconds: 60,
      };
    }
    if (queryState === '503' || queryState === 'service_unavailable') {
      return {
        variant: 'unavailable',
        title: 'Service Unavailable (503)',
        message: 'Verification service is temporarily unavailable. Please try again later.',
      };
    }
    if (queryState === 'offline') {
      return {
        variant: 'offline',
        title: 'Network Offline',
        message: 'Unable to connect to the verification server. Please check your internet connection.',
      };
    }
    return null;
  });

  const validate = (): boolean => {
    if (!otp.trim()) {
      setOtpError('Verification code is required.');
      return false;
    }
    if (!/^\d{6}$/.test(otp.trim())) {
      setOtpError('Please enter a valid 6-digit verification code.');
      return false;
    }
    setOtpError(undefined);
    return true;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) {
      return;
    }

    if (!hasRegistrationContext) {
      setSubmitStatus({
        variant: 'warning',
        title: 'Missing Registration Context',
        message:
          'Cannot verify email without an active registration session and valid registration ID. Please create an account first.',
      });
      return;
    }

    // Honest Phase 2 UI Shell notice — no fake verification or auto-login
    setSubmitStatus({
      variant: 'unavailable',
      title: 'Verification Service Unavailable',
      message:
        'Email verification backend service is not yet deployed (Phase 2 UI Shell). Verification challenges and nonce validation will be connected in future tasks. No account was activated.',
    });
  };

  const handleResend = () => {
    setSubmitStatus({
      variant: 'unavailable',
      title: 'Resend Service Unavailable',
      message:
        'OTP resend endpoint is not yet deployed (Phase 2 UI Shell). No new verification code was dispatched.',
    });
  };

  return (
    <AuthCard
      title="Verify your email"
      subtitle={
        hasRegistrationContext && emailContext
          ? `Enter the 6-digit verification code sent to ${emailContext}`
          : 'Enter your 6-digit verification code to complete account activation'
      }
      footer={
        <div className="space-y-1">
          <div>
            <span>Need a new account? </span>
            <Link
              to="/register"
              className="font-semibold text-[#2563EB] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded"
            >
              Sign up
            </Link>
          </div>
          <div>
            <Link
              to="/login"
              className="text-slate-500 hover:text-slate-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded"
            >
              Return to Sign in
            </Link>
          </div>
        </div>
      }
    >
      {/* Missing Registration Context Guard */}
      {!hasRegistrationContext && (
        <AuthAlert
          variant="warning"
          title="Missing Registration Context"
          message="No active registration session was found. Email verification requires an active registration flow with a valid registration ID. If you have not registered yet, please create an account first."
          action={{
            label: 'Go to Registration',
            href: '/register',
          }}
        />
      )}

      {/* Context Badge if Available */}
      {hasRegistrationContext && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-700 space-y-1">
          {emailContext && (
            <div>
              <span className="font-semibold text-slate-800">Target Email: </span>
              <span>{emailContext}</span>
            </div>
          )}
          {registrationId && (
            <div className="font-mono text-[11px] text-slate-500">
              Registration ID: {registrationId}
            </div>
          )}
        </div>
      )}

      {submitStatus && (
        <AuthAlert
          variant={submitStatus.variant}
          title={submitStatus.title}
          message={submitStatus.message}
          retryAfterSeconds={submitStatus.retryAfterSeconds}
        />
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <OtpInputField
          id="verify-email-otp"
          name="code"
          label="6-Digit Verification Code"
          value={otp}
          onChange={(val) => {
            setOtp(val);
            if (otpError) setOtpError(undefined);
          }}
          error={otpError}
          helperText="Enter the 6-digit numeric code from your verification email."
        />

        <button
          type="submit"
          className="w-full py-2.5 px-4 bg-[#2563EB] hover:bg-blue-700 text-white text-sm font-semibold rounded-lg shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 cursor-pointer"
        >
          Verify Email
        </button>
      </form>

      {/* Resend Section */}
      <div className="pt-2 text-center text-xs text-slate-600">
        <span>Didn&apos;t receive the code? </span>
        <button
          type="button"
          onClick={handleResend}
          className="font-semibold text-[#2563EB] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded cursor-pointer"
        >
          Resend verification code
        </button>
      </div>
    </AuthCard>
  );
}
