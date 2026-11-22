import {
  LivenessResponseSchema,
  ReadinessResponseSchema,
  type LivenessData,
  type ReadinessData,
  type ResponseMeta,
} from '@roundset/contracts';

export type LivenessResult =
  | { kind: 'online'; data: LivenessData; meta: ResponseMeta }
  | { kind: 'offline'; error: string }
  | { kind: 'timeout'; error: string }
  | { kind: 'invalid'; error: string }
  | { kind: 'aborted' };

export type ReadinessResult =
  | { kind: 'ready'; data: ReadinessData; meta: ResponseMeta }
  | { kind: 'not_ready'; data: ReadinessData; meta: ResponseMeta }
  | { kind: 'offline'; error: string }
  | { kind: 'timeout'; error: string }
  | { kind: 'invalid'; error: string }
  | { kind: 'aborted' };

export interface HealthCheckOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_TIMEOUT_MS = 5000;

interface FetchResult {
  response?: Response;
  errorKind?: 'offline' | 'timeout' | 'aborted';
  errorMessage?: string;
}

async function fetchWithTimeout(
  url: string,
  options?: HealthCheckOptions,
): Promise<FetchResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('REQUEST_TIMEOUT'));
  }, timeoutMs);

  const onExternalAbort = () => {
    controller.abort(options?.signal?.reason);
  };

  if (options?.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      return { errorKind: 'aborted' };
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    return { response };
  } catch (err: unknown) {
    if (timedOut) {
      return {
        errorKind: 'timeout',
        errorMessage: `Request timed out after ${timeoutMs}ms`,
      };
    }
    if (options?.signal?.aborted) {
      return { errorKind: 'aborted' };
    }
    const message =
      err instanceof Error ? err.message : 'Network error or backend unreachable';
    return {
      errorKind: 'offline',
      errorMessage: message,
    };
  } finally {
    clearTimeout(timer);
    if (options?.signal) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export async function fetchLiveness(
  options?: HealthCheckOptions,
): Promise<LivenessResult> {
  const { response, errorKind, errorMessage } = await fetchWithTimeout(
    '/api/v1/health/live',
    options,
  );

  if (errorKind) {
    if (errorKind === 'aborted') return { kind: 'aborted' };
    if (errorKind === 'timeout') {
      return { kind: 'timeout', error: errorMessage ?? 'Request timed out' };
    }
    return {
      kind: 'offline',
      error: errorMessage ?? 'Backend offline or unreachable',
    };
  }

  if (!response) {
    return { kind: 'offline', error: 'No response received' };
  }

  if (response.status !== 200) {
    return {
      kind: 'invalid',
      error: `Liveness returned unexpected HTTP ${response.status}`,
    };
  }

  try {
    const rawJson: unknown = await response.json();
    const parsed = LivenessResponseSchema.safeParse(rawJson);
    if (!parsed.success) {
      return {
        kind: 'invalid',
        error: 'Invalid API response schema for liveness',
      };
    }
    return {
      kind: 'online',
      data: parsed.data.data,
      meta: parsed.data.meta,
    };
  } catch {
    return { kind: 'invalid', error: 'Failed to parse JSON response' };
  }
}

export async function fetchReadiness(
  options?: HealthCheckOptions,
): Promise<ReadinessResult> {
  const { response, errorKind, errorMessage } = await fetchWithTimeout(
    '/api/v1/health/ready',
    options,
  );

  if (errorKind) {
    if (errorKind === 'aborted') return { kind: 'aborted' };
    if (errorKind === 'timeout') {
      return { kind: 'timeout', error: errorMessage ?? 'Request timed out' };
    }
    return {
      kind: 'offline',
      error: errorMessage ?? 'Backend offline or unreachable',
    };
  }

  if (!response) {
    return { kind: 'offline', error: 'No response received' };
  }

  // HTTP 200 (ready: true or ready: false) and HTTP 503 (ready: false) are valid readiness statuses
  if (response.status !== 200 && response.status !== 503) {
    return {
      kind: 'invalid',
      error: `Readiness returned unexpected HTTP ${response.status}`,
    };
  }

  try {
    const rawJson: unknown = await response.json();
    const parsed = ReadinessResponseSchema.safeParse(rawJson);
    if (!parsed.success) {
      return {
        kind: 'invalid',
        error: 'Invalid API response schema for readiness',
      };
    }

    if (parsed.data.data.ready) {
      return {
        kind: 'ready',
        data: parsed.data.data,
        meta: parsed.data.meta,
      };
    } else {
      return {
        kind: 'not_ready',
        data: parsed.data.data,
        meta: parsed.data.meta,
      };
    }
  } catch {
    return { kind: 'invalid', error: 'Failed to parse JSON response' };
  }
}

export interface CombinedHealthResult {
  liveness: LivenessResult;
  readiness: ReadinessResult;
}

export async function fetchHealthOverview(
  options?: HealthCheckOptions,
): Promise<CombinedHealthResult> {
  const [liveness, readiness] = await Promise.all([
    fetchLiveness(options),
    fetchReadiness(options),
  ]);
  return { liveness, readiness };
}
