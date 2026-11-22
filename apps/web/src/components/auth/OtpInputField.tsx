import React from 'react';

export interface OtpInputFieldProps {
  id: string;
  name?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  helperText?: string;
}

export function OtpInputField({
  id,
  name = 'code',
  label,
  value,
  onChange,
  error,
  disabled = false,
  required = true,
  helperText = 'Enter the 6-digit verification code sent to your email.',
}: OtpInputFieldProps) {
  const errorId = `${id}-error`;
  const helperId = `${id}-helper`;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Only allow digits up to 6 characters
    const sanitized = e.target.value.replace(/\D/g, '').slice(0, 6);
    onChange(sanitized);
  };

  const describedBy = [
    error ? errorId : null,
    helperText ? helperId : null,
  ].filter(Boolean).join(' ') || undefined;

  return (
    <div className="space-y-1.5 text-left">
      <label
        htmlFor={id}
        className="block text-xs font-semibold text-[#0F172A] tracking-wide"
      >
        {label}
        {required && (
          <span className="text-red-500 ml-0.5" aria-hidden="true">
            *
          </span>
        )}
      </label>

      <div className="relative">
        <input
          id={id}
          name={name}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          required={required}
          placeholder="••••••"
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          className={`w-full tracking-widest text-center text-lg font-mono font-semibold px-4 py-2.5 bg-white rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed ${
            error
              ? 'border-red-400 text-red-900 focus-visible:ring-red-500'
              : 'border-[#E2E8F0] text-[#0F172A] hover:border-slate-300'
          }`}
        />
      </div>

      {helperText && !error && (
        <p id={helperId} className="text-xs text-slate-500 text-center">
          {helperText}
        </p>
      )}

      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-red-600 text-center">
          {error}
        </p>
      )}
    </div>
  );
}
