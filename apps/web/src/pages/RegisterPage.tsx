import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthCard } from '../components/auth/AuthCard';
import { FormField } from '../components/auth/FormField';
import { AuthAlert, type AuthAlertVariant } from '../components/auth/AuthAlert';
import { fetchAuthMeta, type AuthMetaData } from '../lib/api';
import { validateNewPassword } from '../lib/validation';

export function RegisterPage() {
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [consentChecked, setConsentChecked] = useState(false);

  // Policy discovery state
  const [policyLoading, setPolicyLoading] = useState(true);
  const [policyMeta, setPolicyMeta] = useState<AuthMetaData | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);

  const [errors, setErrors] = useState<{
    email?: string;
    password?: string;
    displayName?: string;
    consent?: string;
  }>({});

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
        title: 'Too Many Requests (429)',
        message: 'Registration rate limit exceeded. Please wait before creating an account.',
        retryAfterSeconds: 60,
      };
    }
    if (queryState === '503' || queryState === 'service_unavailable') {
      return {
        variant: 'unavailable',
        title: 'Service Unavailable (503)',
        message: 'Registration service is temporarily unavailable. Please try again later.',
      };
    }
    if (queryState === 'offline') {
      return {
        variant: 'offline',
        title: 'Network Offline',
        message: 'Unable to connect to the registration server. Please check your internet connection.',
      };
    }
    return null;
  });

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    async function loadPolicy() {
      setPolicyLoading(true);
      setPolicyError(null);

      const result = await fetchAuthMeta({ signal: controller.signal });
      if (!mounted) return;

      if (result.kind === 'success') {
        setPolicyMeta(result.data);
        setPolicyLoading(false);
      } else if (result.kind === 'aborted') {
        // Ignored
      } else {
        setPolicyError(
          result.kind === 'offline'
            ? 'Registration server unreachable. Active policy discovery failed.'
            : `Registration policy currently unavailable (endpoint returned ${result.kind}).`,
        );
        setPolicyLoading(false);
      }
    }

    loadPolicy();

    return () => {
      mounted = false;
      controller.abort();
    };
  }, []);

  const validate = (): boolean => {
    const newErrors: {
      email?: string;
      password?: string;
      displayName?: string;
      consent?: string;
    } = {};

    if (!email.trim()) {
      newErrors.email = 'Email address is required.';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      newErrors.email = 'Please enter a valid email address.';
    }

    const passwordError = validateNewPassword(password);
    if (passwordError) {
      newErrors.password = passwordError;
    }

    // Consent validation: cannot proceed without discovered policy
    if (!policyMeta) {
      newErrors.consent =
        'Consent-dependent registration cannot proceed without an available current policy from the server.';
    } else if (!consentChecked) {
      newErrors.consent = 'You must agree to the policy terms to create an account.';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) {
      return;
    }

    // Honest Phase 2 UI Shell notice — no fake account creation
    setSubmitStatus({
      variant: 'unavailable',
      title: 'Registration Service Unavailable',
      message:
        'Registration backend service is not yet deployed (Phase 2 UI Shell). Real pending registration and email OTP delivery will be connected in future tasks. No user account was created.',
    });
  };

  return (
    <AuthCard
      title="Create your Roundset account"
      subtitle="Sign up to start your AI-led technical interview preparation"
      footer={
        <div>
          <span>Already have an account? </span>
          <Link
            to="/login"
            className="font-semibold text-[#2563EB] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded"
          >
            Sign in
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

      {/* Policy Discovery Warnings or Notices */}
      {policyLoading && (
        <p className="text-xs text-slate-500 italic text-center">
          Discovering active policy terms from server (/auth/meta)...
        </p>
      )}

      {policyError && !policyLoading && (
        <AuthAlert
          variant="warning"
          title="Policy Discovery Unavailable"
          message={`${policyError} Consent-dependent registration cannot proceed without an available current policy.`}
        />
      )}

      {policyMeta?.registrationMode === 'INVITE_ONLY' && (
        <AuthAlert
          variant="info"
          title="Invite-Only Registration"
          message="Roundset is currently in invite-only admission mode. Account creation requires a pre-approved email address."
        />
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <FormField
          id="register-email"
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
          id="register-name"
          name="displayName"
          label="Display name (optional)"
          type="text"
          autoComplete="name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={errors.displayName}
          placeholder="Alex Candidate"
          helperText="How should interviewer Ellis address you?"
        />

        <FormField
          id="register-password"
          name="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }));
          }}
          error={errors.password}
          placeholder="••••••••"
          helperText="Must be 12–128 characters long."
        />

        {/* Consent Checkbox */}
        <div className="pt-1">
          <div className="flex items-start gap-2.5">
            <input
              id="register-consent"
              name="consent"
              type="checkbox"
              disabled={policyLoading || !policyMeta}
              checked={consentChecked}
              onChange={(e) => {
                setConsentChecked(e.target.checked);
                if (errors.consent) setErrors((prev) => ({ ...prev, consent: undefined }));
              }}
              aria-invalid={Boolean(errors.consent)}
              aria-describedby={errors.consent ? 'register-consent-error' : undefined}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-[#2563EB] focus:ring-[#2563EB] disabled:cursor-not-allowed disabled:opacity-50"
            />
            <label
              htmlFor="register-consent"
              className={`text-xs leading-normal select-none ${
                policyMeta ? 'text-slate-700' : 'text-slate-400'
              }`}
            >
              {policyMeta ? (
                <span>
                  I acknowledge and agree to the Roundset terms{' '}
                  <span className="font-semibold text-slate-800">
                    ({policyMeta.activePolicyId}, v{policyMeta.activeConsentVersion})
                  </span>
                  .
                </span>
              ) : (
                <span>
                  I acknowledge and agree to the active terms (Policy unavailable from server).
                </span>
              )}
            </label>
          </div>

          {errors.consent && (
            <p
              id="register-consent-error"
              role="alert"
              className="mt-1.5 text-xs font-medium text-red-600"
            >
              {errors.consent}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={policyLoading || !policyMeta}
          className="w-full py-2.5 px-4 bg-[#2563EB] hover:bg-blue-700 text-white text-sm font-semibold rounded-lg shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 cursor-pointer disabled:bg-slate-300 disabled:cursor-not-allowed"
        >
          Create Account
        </button>
      </form>
    </AuthCard>
  );
}
