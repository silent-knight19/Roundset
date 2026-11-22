import { useState } from 'react';
import { NavLink, Link, Outlet } from 'react-router-dom';

export function AppLayout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navLinkClasses = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-2 text-sm font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] ${
      isActive
        ? 'text-[#2563EB] bg-blue-50/60 font-semibold'
        : 'text-slate-600 hover:text-[#0F172A] hover:bg-slate-100/60'
    }`;

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A]">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-xs border-b border-[#E2E8F0]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Wordmark / Brand */}
            <div className="flex items-center gap-3">
              <Link
                to="/"
                className="flex items-center gap-2 text-lg font-bold tracking-tight text-[#0F172A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded-md px-1"
                aria-label="Roundset Home"
              >
                <span className="w-8 h-8 rounded-lg bg-[#2563EB] text-white flex items-center justify-center font-bold text-base shadow-xs">
                  R
                </span>
                <span>Roundset</span>
              </Link>
              <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">
                Phase 1 Scaffold
              </span>
            </div>

            {/* Desktop Navigation */}
            <nav
              aria-label="Primary"
              className="hidden md:flex items-center space-x-1"
            >
              <NavLink to="/" end className={navLinkClasses}>
                Home
              </NavLink>
              <NavLink to="/interview" className={navLinkClasses}>
                Interview
              </NavLink>
              <NavLink to="/dashboard" className={navLinkClasses}>
                Dashboard
              </NavLink>
              <NavLink to="/pricing" className={navLinkClasses}>
                Pricing
              </NavLink>
              {/* Non-interactive disabled Admin placeholder */}
              <span
                aria-disabled="true"
                title="Admin portal inactive in Phase 1 (requires RBAC)"
                className="px-3 py-1.5 text-xs font-medium text-slate-400 bg-slate-50 border border-slate-200 border-dashed rounded-md cursor-not-allowed select-none ml-2"
              >
                Admin (Disabled)
              </span>

              <div className="flex items-center gap-1.5 ml-3 pl-3 border-l border-slate-200">
                <NavLink to="/login" className={navLinkClasses}>
                  Sign In
                </NavLink>
                <NavLink
                  to="/register"
                  className="px-3 py-1.5 text-xs font-semibold rounded-md bg-[#2563EB] text-white hover:bg-blue-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
                >
                  Register
                </NavLink>
              </div>
            </nav>

            {/* Mobile menu button */}
            <div className="flex md:hidden">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                aria-expanded={mobileMenuOpen}
                aria-label="Toggle navigation menu"
                className="p-2 rounded-md text-slate-600 hover:text-[#0F172A] hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
              >
                <svg
                  className="h-6 w-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth="1.5"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  {mobileMenuOpen ? (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  ) : (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                    />
                  )}
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Mobile menu dropdown */}
        {mobileMenuOpen && (
          <nav
            aria-label="Mobile Navigation"
            className="md:hidden border-t border-[#E2E8F0] bg-white px-4 pt-2 pb-3 space-y-1"
          >
            <NavLink
              to="/"
              end
              onClick={() => setMobileMenuOpen(false)}
              className={navLinkClasses}
            >
              Home
            </NavLink>
            <NavLink
              to="/interview"
              onClick={() => setMobileMenuOpen(false)}
              className={navLinkClasses}
            >
              Interview
            </NavLink>
            <NavLink
              to="/dashboard"
              onClick={() => setMobileMenuOpen(false)}
              className={navLinkClasses}
            >
              Dashboard
            </NavLink>
            <NavLink
              to="/pricing"
              onClick={() => setMobileMenuOpen(false)}
              className={navLinkClasses}
            >
              Pricing
            </NavLink>
            <div className="pt-2">
              <span
                aria-disabled="true"
                className="inline-block px-3 py-1.5 text-xs font-medium text-slate-400 bg-slate-50 border border-slate-200 border-dashed rounded-md cursor-not-allowed select-none"
              >
                Admin (Disabled — Requires RBAC)
              </span>
            </div>
            <div className="pt-2 border-t border-slate-200 flex flex-col gap-1">
              <NavLink
                to="/login"
                onClick={() => setMobileMenuOpen(false)}
                className={navLinkClasses}
              >
                Sign In
              </NavLink>
              <NavLink
                to="/register"
                onClick={() => setMobileMenuOpen(false)}
                className={navLinkClasses}
              >
                Register
              </NavLink>
            </div>
          </nav>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-[#E2E8F0] mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <div>
            <span className="font-semibold text-slate-700">Roundset</span> · AI Technical Interviewer (Persona: Ellis)
          </div>
          <div>
            Phase 1 Foundation · Strict Type Contracts · Express &amp; Vite Architecture
          </div>
        </div>
      </footer>
    </div>
  );
}
