import React from 'react';

export type AuthAlertVariant =
  | 'error'
  | 'warning'
  | 'rate_limit'
  | 'offline'
  | 'unavailable'
  | 'info';

export interface AuthAlertProps {
  variant: AuthAlertVariant;
  title?: string;
  message: string;
  retryAfterSeconds?: number;
  className?: string;
  action?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
}

export function AuthAlert({
  variant,
  title,
  message,
  retryAfterSeconds,
  className = '',
  action,
}: AuthAlertProps) {
  const isAssertive = variant === 'error' || variant === 'rate_limit' || variant === 'offline';
  const role = isAssertive ? 'alert' : 'status';
  const ariaLive = isAssertive ? 'assertive' : 'polite';

  let borderStyle = 'border-slate-200 bg-slate-50 text-slate-800';
  let iconColor = 'text-slate-500';

  switch (variant) {
    case 'error':
      borderStyle = 'border-red-200 bg-red-50/80 text-red-900';
      iconColor = 'text-red-600';
      break;
    case 'rate_limit':
      borderStyle = 'border-amber-200 bg-amber-50/80 text-amber-900';
      iconColor = 'text-amber-600';
      break;
    case 'offline':
      borderStyle = 'border-orange-200 bg-orange-50/80 text-orange-900';
      iconColor = 'text-orange-600';
      break;
    case 'warning':
      borderStyle = 'border-yellow-200 bg-yellow-50/80 text-yellow-900';
      iconColor = 'text-yellow-600';
      break;
    case 'unavailable':
      borderStyle = 'border-blue-200 bg-blue-50/80 text-blue-900';
      iconColor = 'text-[#2563EB]';
      break;
    case 'info':
      borderStyle = 'border-sky-200 bg-sky-50/80 text-sky-900';
      iconColor = 'text-sky-600';
      break;
  }

  const renderIcon = () => {
    switch (variant) {
      case 'error':
        return (
          <svg className={`w-5 h-5 ${iconColor} shrink-0 mt-0.5`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
          </svg>
        );
      case 'rate_limit':
        return (
          <svg className={`w-5 h-5 ${iconColor} shrink-0 mt-0.5`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 000-1.5h-3.25V5z" clipRule="evenodd" />
          </svg>
        );
      case 'offline':
        return (
          <svg className={`w-5 h-5 ${iconColor} shrink-0 mt-0.5`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 00-1.06 1.06l14.5 14.5a.75.75 0 101.06-1.06l-1.745-1.745a10.029 10.029 0 003.3-4.38 1.651 1.651 0 000-1.185A10.004 10.004 0 009.999 3a9.956 9.956 0 00-4.744 1.194L3.28 2.22zM7.752 6.69l1.69 1.69a2.5 2.5 0 013.178 3.178l2.096 2.096A6.5 6.5 0 007.752 6.69z" clipRule="evenodd" />
          </svg>
        );
      case 'warning':
      case 'unavailable':
        return (
          <svg className={`w-5 h-5 ${iconColor} shrink-0 mt-0.5`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
          </svg>
        );
      case 'info':
      default:
        return (
          <svg className={`w-5 h-5 ${iconColor} shrink-0 mt-0.5`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
          </svg>
        );
    }
  };

  return (
    <div
      role={role}
      aria-live={ariaLive}
      className={`rounded-lg border p-4 text-sm flex gap-3 items-start ${borderStyle} ${className}`}
    >
      {renderIcon()}
      <div className="flex-1 min-w-0">
        {title && <h3 className="font-semibold text-sm mb-1">{title}</h3>}
        <p className="leading-relaxed">{message}</p>
        {retryAfterSeconds !== undefined && (
          <p className="mt-1.5 text-xs font-medium opacity-90">
            Retry after: {retryAfterSeconds} seconds
          </p>
        )}
        {action && (
          <div className="mt-3">
            {action.href ? (
              <a
                href={action.href}
                className="inline-flex items-center text-xs font-semibold underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded"
              >
                {action.label}
              </a>
            ) : (
              <button
                type="button"
                onClick={action.onClick}
                className="inline-flex items-center text-xs font-semibold underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded cursor-pointer"
              >
                {action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
