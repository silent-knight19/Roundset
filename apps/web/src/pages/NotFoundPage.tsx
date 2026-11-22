import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="max-w-xl mx-auto py-12 text-center space-y-4">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-slate-100 text-slate-600 mb-2 font-mono font-bold text-lg border border-slate-200">
        404
      </div>
      <h1 className="text-2xl font-bold tracking-tight text-[#0F172A]">
        Page Not Found
      </h1>
      <p className="text-sm text-slate-600 leading-relaxed max-w-md mx-auto">
        The requested page does not exist or has not been implemented. If you were attempting to access administrative controls, please note that no administrative interface is accessible without verified authentication and RBAC.
      </p>
      <div className="pt-4">
        <Link
          to="/"
          className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
        >
          Return to Home
        </Link>
      </div>
    </div>
  );
}
