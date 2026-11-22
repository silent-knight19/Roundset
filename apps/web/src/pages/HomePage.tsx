import { HealthStatus } from '../components/HealthStatus';
import { Link } from 'react-router-dom';

export function HomePage() {
  return (
    <div className="space-y-8">
      {/* Introduction Hero */}
      <section className="bg-white border border-[#E2E8F0] rounded-xl p-8 shadow-xs">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-[#2563EB] border border-blue-200 mb-4">
            Phase 1 Foundation · Architecture Baseline
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#0F172A]">
            Roundset AI Interviewer
          </h1>
          <p className="mt-3 text-base text-slate-600 leading-relaxed">
            Welcome to the Roundset technical interview platform foundation. Roundset features
            <strong className="text-[#0F172A] font-semibold"> Ellis</strong>, our AI interviewer persona designed for rigorous, fair, and adaptive engineering assessments.
          </p>
          <p className="mt-2 text-sm text-slate-500 leading-relaxed">
            This deployment serves as the Phase 1 architectural scaffold, providing strict TypeScript contracts, live health monitoring, and modular extension seams for upcoming voice and interview pipelines.
          </p>
        </div>

        {/* Quick Route Cards */}
        <div className="mt-6 pt-6 border-t border-[#E2E8F0] grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Link
            to="/interview"
            className="p-4 rounded-lg border border-[#E2E8F0] hover:border-[#2563EB] hover:bg-blue-50/20 transition-all group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
          >
            <h3 className="text-sm font-semibold text-[#0F172A] group-hover:text-[#2563EB]">
              Interview Session &rarr;
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Voice and adaptive technical conversation runtime (Phase 4 &amp; 5).
            </p>
          </Link>

          <Link
            to="/dashboard"
            className="p-4 rounded-lg border border-[#E2E8F0] hover:border-[#2563EB] hover:bg-blue-50/20 transition-all group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
          >
            <h3 className="text-sm font-semibold text-[#0F172A] group-hover:text-[#2563EB]">
              Candidate Dashboard &rarr;
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Candidate history, reports, and identity management (Phase 2 &amp; 7).
            </p>
          </Link>

          <Link
            to="/pricing"
            className="p-4 rounded-lg border border-[#E2E8F0] hover:border-[#2563EB] hover:bg-blue-50/20 transition-all group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
          >
            <h3 className="text-sm font-semibold text-[#0F172A] group-hover:text-[#2563EB]">
              Plans &amp; Quotas &rarr;
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Free tier and credit packages overview (Phase 3 &amp; 10).
            </p>
          </Link>
        </div>
      </section>

      {/* Backend Health Check */}
      <HealthStatus />

      {/* Engineering Guardrails Overview */}
      <section className="bg-white border border-[#E2E8F0] rounded-xl p-6 shadow-xs">
        <h3 className="text-sm font-semibold text-[#0F172A] uppercase tracking-wider text-slate-500">
          Architecture &amp; Safety Guardrails
        </h3>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm text-slate-600">
          <div className="border border-slate-100 bg-slate-50/50 rounded-lg p-3">
            <h4 className="font-medium text-[#0F172A] mb-1">Strict Type Contracts</h4>
            <p className="text-xs text-slate-500">
              Shared Zod schemas via <code className="text-slate-700 font-mono">@roundset/contracts</code> guarantee deterministic DTO validation between frontend and backend.
            </p>
          </div>
          <div className="border border-slate-100 bg-slate-50/50 rounded-lg p-3">
            <h4 className="font-medium text-[#0F172A] mb-1">Decoupled Readiness</h4>
            <p className="text-xs text-slate-500">
              Liveness (/health/live) reports process health independently of database readiness (/health/ready), distinguishing network faults from startup delays.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
