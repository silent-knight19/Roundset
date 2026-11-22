import React from 'react';
import { Link } from 'react-router-dom';

export interface AuthCardProps {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function AuthCard({ title, subtitle, children, footer }: AuthCardProps) {
  return (
    <div className="w-full max-w-md mx-auto my-8">
      <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-xs p-6 sm:p-8">
        {/* Brand Header */}
        <div className="flex flex-col items-center text-center mb-6">
          <Link
            to="/"
            className="flex items-center gap-2 text-xl font-bold tracking-tight text-[#0F172A] mb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded-md px-1"
            aria-label="Roundset Home"
          >
            <span className="w-9 h-9 rounded-lg bg-[#2563EB] text-white flex items-center justify-center font-bold text-lg shadow-xs">
              R
            </span>
            <span>Roundset</span>
          </Link>
          <h1 className="text-xl font-bold text-[#0F172A] tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-slate-600 leading-normal">{subtitle}</p>
        </div>

        {/* Form / Content */}
        <div className="space-y-5">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="mt-6 pt-5 border-t border-[#E2E8F0] text-center text-xs text-slate-600 space-y-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
