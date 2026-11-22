import { Link } from 'react-router-dom';

export function InterviewPage() {
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="bg-white border border-[#E2E8F0] rounded-xl p-8 shadow-xs">
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200 mb-4">
          Status: Not Yet Implemented (Phase 4 &amp; 5)
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-[#0F172A]">
          Interview Session
        </h1>
        <p className="mt-3 text-slate-600 leading-relaxed text-sm">
          The conversational interview runtime with AI persona <strong>Ellis</strong> is scheduled for implementation in <strong>Phase 4 (AI Interview Engine)</strong> and <strong>Phase 5 (Real-Time Voice Pipeline)</strong>.
        </p>

        <div className="mt-6 p-4 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 space-y-2">
          <p className="font-semibold text-slate-800">Planned Architecture:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>Groq Qwen primary LLM adapter with failover handling.</li>
            <li>In-browser speech recognition and Kokoro TTS integration.</li>
            <li>Server-authoritative interview state machine and turn checkpoints.</li>
            <li>Strict proctoring and integrity observations (Phase 6).</li>
          </ul>
        </div>

        <div className="mt-6 pt-6 border-t border-[#E2E8F0] flex items-center justify-between">
          <span className="text-xs text-slate-400">No mock interview session is simulated in Phase 1.</span>
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
