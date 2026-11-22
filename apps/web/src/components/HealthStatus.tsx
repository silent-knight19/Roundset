import { useEffect, useRef, useState, useCallback } from 'react';
import {
  fetchHealthOverview,
  type LivenessResult,
  type ReadinessResult,
} from '../lib/api';

export function HealthStatus() {
  const [isChecking, setIsChecking] = useState<boolean>(true);
  const [liveness, setLiveness] = useState<LivenessResult | null>(null);
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  // Request counter to discard stale async responses
  const activeRequestIdRef = useRef<number>(0);
  const activeControllerRef = useRef<AbortController | null>(null);

  const runCheck = useCallback(() => {
    // Abort previous in-flight request if any
    if (activeControllerRef.current) {
      activeControllerRef.current.abort();
    }

    const nextId = activeRequestIdRef.current + 1;
    activeRequestIdRef.current = nextId;

    const controller = new AbortController();
    activeControllerRef.current = controller;

    setIsChecking(true);

    fetchHealthOverview({ signal: controller.signal })
      .then((result) => {
        // Discard if a newer request has started
        if (activeRequestIdRef.current !== nextId) {
          return;
        }

        // Ignore if cancelled
        if (
          result.liveness.kind === 'aborted' ||
          result.readiness.kind === 'aborted'
        ) {
          return;
        }

        setLiveness(result.liveness);
        setReadiness(result.readiness);
        setLastChecked(new Date());
        setIsChecking(false);
      })
      .catch((err: unknown) => {
        if (activeRequestIdRef.current !== nextId) {
          return;
        }
        const errorMsg =
          err instanceof Error ? err.message : 'Unknown health check error';
        setLiveness({ kind: 'offline', error: errorMsg });
        setReadiness({ kind: 'offline', error: errorMsg });
        setIsChecking(false);
      });
  }, []);

  useEffect(() => {
    runCheck();
    return () => {
      if (activeControllerRef.current) {
        activeControllerRef.current.abort();
      }
    };
  }, [runCheck]);

  // Compute overall status summary for accessible status announcement
  const getOverallSummary = (): string => {
    if (isChecking) {
      return 'Checking connection to backend health services...';
    }

    const hasTimeout =
      liveness?.kind === 'timeout' || readiness?.kind === 'timeout';
    if (hasTimeout) {
      return 'Request timeout: health verification timed out after 5 seconds.';
    }

    const hasInvalid =
      liveness?.kind === 'invalid' || readiness?.kind === 'invalid';
    if (hasInvalid) {
      return 'Invalid API response: health response failed contract schema validation or contained contradictory data.';
    }

    const hasUnavailable =
      liveness?.kind === 'unavailable' || readiness?.kind === 'unavailable';
    if (hasUnavailable) {
      return 'Backend service unavailable: health endpoint or proxy returned an unexpected HTTP error.';
    }

    const isOffline =
      liveness?.kind === 'offline' && readiness?.kind === 'offline';
    if (isOffline) {
      return 'Backend offline: connection refused or server unreachable.';
    }

    if (liveness?.kind === 'online') {
      if (readiness?.kind === 'ready') {
        return 'Backend online and backend ready: all services operational.';
      }
      if (readiness?.kind === 'not_ready') {
        return 'Backend online but backend not ready: dependencies are initializing (HTTP 503).';
      }
      return 'Backend online: readiness check offline or unreachable.';
    }

    return 'Backend offline: unable to establish connection.';
  };

  return (
    <section
      aria-labelledby="health-status-title"
      className="bg-white border border-[#E2E8F0] rounded-xl p-6 shadow-xs"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#E2E8F0]">
        <div>
          <h2
            id="health-status-title"
            className="text-lg font-semibold text-[#0F172A]"
          >
            Backend Health &amp; Readiness
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Real-time verification of backend HTTP liveness and dependency readiness.
          </p>
        </div>
        <button
          type="button"
          onClick={runCheck}
          disabled={isChecking}
          className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-[#2563EB] hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
        >
          {isChecking ? 'Checking...' : 'Refresh Status'}
        </button>
      </div>

      {/* Accessible live region */}
      <div
        role="status"
        aria-live="polite"
        className="mt-4 p-3 rounded-lg text-sm bg-slate-50 border border-slate-200 text-[#0F172A]"
      >
        <span className="font-medium">Status Summary: </span>
        <span>{getOverallSummary()}</span>
      </div>

      {/* Health status grid */}
      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Liveness Card */}
        <div className="border border-[#E2E8F0] rounded-lg p-4 bg-slate-50/50">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-slate-700">
              Liveness Endpoint
            </span>
            <code className="text-xs text-slate-500 font-mono">
              /api/v1/health/live
            </code>
          </div>

          <div className="mt-3">
            {isChecking && (
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
                <span>Checking connection...</span>
              </div>
            )}

            {!isChecking && liveness?.kind === 'online' && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500" />
                  <span className="text-sm font-semibold text-emerald-800">
                    Backend online
                  </span>
                </div>
                <div className="text-xs text-slate-600 pl-4 space-y-0.5">
                  <p>Version: <span className="font-mono">{liveness.data.version}</span></p>
                  <p>Request ID: <span className="font-mono">{liveness.meta.requestId}</span></p>
                </div>
              </div>
            )}

            {!isChecking && liveness?.kind === 'unavailable' && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500" />
                  <span className="text-sm font-semibold text-amber-800">
                    Backend unavailable
                  </span>
                </div>
                <p className="text-xs text-amber-700 pl-4">
                  {liveness.error}
                </p>
              </div>
            )}

            {!isChecking && liveness?.kind === 'offline' && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-rose-500" />
                  <span className="text-sm font-semibold text-rose-800">
                    Backend offline
                  </span>
                </div>
                <p className="text-xs text-rose-600 pl-4">
                  {liveness.error}
                </p>
              </div>
            )}

            {!isChecking && liveness?.kind === 'timeout' && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500" />
                  <span className="text-sm font-semibold text-amber-800">
                    Request timeout
                  </span>
                </div>
                <p className="text-xs text-amber-600 pl-4">
                  {liveness.error}
                </p>
              </div>
            )}

            {!isChecking && liveness?.kind === 'invalid' && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-rose-500" />
                  <span className="text-sm font-semibold text-rose-800">
                    Invalid API response
                  </span>
                </div>
                <p className="text-xs text-rose-600 pl-4">
                  {liveness.error}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Readiness Card */}
        <div className="border border-[#E2E8F0] rounded-lg p-4 bg-slate-50/50">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-slate-700">
              Readiness Endpoint
            </span>
            <code className="text-xs text-slate-500 font-mono">
              /api/v1/health/ready
            </code>
          </div>

          <div className="mt-3">
            {isChecking && (
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
                <span>Checking connection...</span>
              </div>
            )}

            {!isChecking && readiness?.kind === 'ready' && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500" />
                  <span className="text-sm font-semibold text-emerald-800">
                    Backend ready
                  </span>
                </div>
                <div className="text-xs text-slate-600 pl-4">
                  <p>Request ID: <span className="font-mono">{readiness.meta.requestId}</span></p>
                  <p className="text-emerald-700 mt-1">Database &amp; dependencies operational.</p>
                </div>
              </div>
            )}

            {!isChecking && readiness?.kind === 'not_ready' && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500" />
                  <span className="text-sm font-semibold text-amber-800">
                    Backend not ready
                  </span>
                </div>
                <div className="text-xs text-amber-700 pl-4 space-y-1">
                  <p>HTTP 503 received: Server is running but required dependencies (e.g. MongoDB) are not ready.</p>
                  <p>Request ID: <span className="font-mono">{readiness.meta.requestId}</span></p>
                </div>
              </div>
            )}

            {!isChecking && readiness?.kind === 'unavailable' && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500" />
                  <span className="text-sm font-semibold text-amber-800">
                    Backend unavailable
                  </span>
                </div>
                <p className="text-xs text-amber-700 pl-4">
                  {readiness.error}
                </p>
              </div>
            )}

            {!isChecking && readiness?.kind === 'offline' && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-rose-500" />
                  <span className="text-sm font-semibold text-rose-800">
                    Backend offline
                  </span>
                </div>
                <p className="text-xs text-rose-600 pl-4">
                  {readiness.error}
                </p>
              </div>
            )}

            {!isChecking && readiness?.kind === 'timeout' && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500" />
                  <span className="text-sm font-semibold text-amber-800">
                    Request timeout
                  </span>
                </div>
                <p className="text-xs text-amber-600 pl-4">
                  {readiness.error}
                </p>
              </div>
            )}

            {!isChecking && readiness?.kind === 'invalid' && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-rose-500" />
                  <span className="text-sm font-semibold text-rose-800">
                    Invalid API response
                  </span>
                </div>
                <p className="text-xs text-rose-600 pl-4">
                  {readiness.error}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {lastChecked && (
        <div className="mt-4 pt-3 border-t border-[#E2E8F0] flex justify-between items-center text-xs text-slate-500">
          <span>Verified via relative API endpoint</span>
          <span>Last checked: {lastChecked.toLocaleTimeString()}</span>
        </div>
      )}
    </section>
  );
}
