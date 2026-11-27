import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../app/AuthContext';

export interface ProtectedRouteProps {
  children: React.ReactNode;
  routeLabel?: string;
}

/**
 * UX-only route guard for candidate-authenticated routes.
 * Server authorization remains authoritative on all API endpoints.
 */
export function ProtectedRoute({
  children,
  routeLabel = 'this page',
}: ProtectedRouteProps) {
  const { status, reloginReason, error, refresh } = useAuth();

  if (status === 'loading') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="max-w-xl mx-auto mt-8 bg-white border border-[#E2E8F0] rounded-xl p-8 shadow-xs text-center space-y-3"
      >
        <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-[#2563EB]" />
        <h1 className="text-lg font-semibold text-[#0F172A]">Restoring session...</h1>
        <p className="text-sm text-slate-600">
          Verifying your session before opening {routeLabel}.
        </p>
      </div>
    );
  }

  if (status === 'authenticated') {
    return <>{children}</>;
  }

  const isRelogin = status === 'relogin_required';
  const isUnavailable = status === 'unavailable';

  const heading = isRelogin
    ? 'Please sign in again'
    : isUnavailable
      ? 'Authentication service unavailable'
      : 'Sign in required';

  const description = isRelogin
    ? reloginReason === 'replay_detected'
      ? 'A session replay or stale token reuse was detected. Your session was revoked for security — please sign in again.'
      : (error ??
        'Your session state could not be confirmed safely. Please sign in again to continue.')
    : isUnavailable
      ? (error ??
        'Unable to verify your session because the authentication service is temporarily unavailable.')
      : `You need an active Roundset session to access ${routeLabel}.`;

  return (
    <div className="max-w-xl mx-auto mt-8 bg-white border border-[#E2E8F0] rounded-xl p-8 shadow-xs space-y-5">
      <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200">
        {isRelogin
          ? 'Reauthentication Required'
          : isUnavailable
            ? 'Service Unavailable'
            : 'Authentication Required'}
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight text-[#0F172A]">{heading}</h1>
        <p className="text-sm text-slate-600 leading-relaxed">{description}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <Link
          to="/login"
          className="px-4 py-2 text-sm font-semibold rounded-md bg-[#2563EB] text-white hover:bg-blue-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
        >
          Go to Sign In
        </Link>
        {isUnavailable && (
          <button
            type="button"
            onClick={() => void refresh()}
            className="px-4 py-2 text-sm font-medium rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
          >
            Retry session check
          </button>
        )}
        <Link
          to="/"
          className="text-sm font-medium text-slate-600 hover:text-[#0F172A] px-2 py-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
        >
          &larr; Back to Home
        </Link>
      </div>
    </div>
  );
}
