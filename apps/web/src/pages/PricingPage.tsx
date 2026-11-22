import { Link } from 'react-router-dom';

export function PricingPage() {
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="bg-white border border-[#E2E8F0] rounded-xl p-8 shadow-xs">
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200 mb-4">
          Status: Not Yet Implemented (Phase 3 &amp; 10)
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-[#0F172A]">
          Plans &amp; Pricing Catalog
        </h1>
        <p className="mt-3 text-slate-600 leading-relaxed text-sm">
          Subscription tiers and interview credit packages are scheduled for implementation in <strong>Phase 3 (Entitlements)</strong> and <strong>Phase 10 (Billing Sandbox &amp; Admin)</strong>.
        </p>

        <div className="mt-6 p-4 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 space-y-2">
          <p className="font-semibold text-slate-800">Approved Platform Plan Structure:</p>
          <ul className="list-disc list-inside space-y-1">
            <li><strong>Free Tier:</strong> 1 × 15-minute technical assessment per month (resets on 1st of month, Asia/Kolkata timezone).</li>
            <li><strong>Package 1:</strong> ₹250 for 10 interview credits.</li>
            <li><strong>Package 2:</strong> ₹500 for 25 interview credits.</li>
            <li><strong>Package 3:</strong> ₹1,000 for 50 interview credits.</li>
            <li><strong>VIP / Invite:</strong> Cryptographically verified invitation vouchers for full access without payments.</li>
          </ul>
        </div>

        <div className="mt-6 pt-6 border-t border-[#E2E8F0] flex items-center justify-between">
          <span className="text-xs text-slate-400">No mock checkout or payment processing is simulated in Phase 1.</span>
          <Link
            to="/"
            className="text-sm font-medium text-[#2563EB] hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] rounded px-1"
          >
            &larr; Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
