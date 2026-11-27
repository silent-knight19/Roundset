import {
  logoutAllSessions,
  logoutSession,
  refreshSession,
  type AuthRequestOptions,
  type LogoutAllResult,
  type LogoutResult,
  type RefreshSessionResult,
} from './authClient';

export const AUTH_REFRESH_LOCK_NAME = 'roundset:auth:refresh';
export const AUTH_BROADCAST_CHANNEL_NAME = 'roundset:auth:channel';
export const AUTH_SYNC_MARKER_KEY = 'roundset:auth:sync_marker';
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;

export type AuthBroadcastEvent =
  | {
      type: 'LOGOUT';
      senderId: string;
    }
  | {
      type: 'LOGOUT_ALL';
      senderId: string;
    }
  | {
      type: 'SESSION_INVALIDATED';
      senderId: string;
      reason: 'replay_detected' | 'relogin_required' | 'uncertain_refresh';
    };

interface CrossTabSyncMarker {
  kind: 'uncertain' | 'replay_detected' | 'relogin_required';
  at: number;
  senderId: string;
}

export interface SessionCoordinatorCallbacks {
  onExternalLogout: (reason: 'logout' | 'logout_all') => void;
  onExternalInvalidation: (
    reason: 'replay_detected' | 'relogin_required' | 'uncertain_refresh',
  ) => void;
}

export interface CoordinatorRefreshOptions extends AuthRequestOptions {
  lockTimeoutMs?: number;
}

function createTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export function isWebLocksSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.locks !== 'undefined' &&
    typeof navigator.locks.request === 'function'
  );
}

export function isBroadcastChannelSupported(): boolean {
  return typeof BroadcastChannel !== 'undefined';
}

function writeCrossTabSyncMarker(marker: CrossTabSyncMarker): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(AUTH_SYNC_MARKER_KEY, JSON.stringify(marker));
    }
  } catch {
    // Ignore storage quota/access errors
  }
}

function clearCrossTabSyncMarker(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(AUTH_SYNC_MARKER_KEY);
    }
  } catch {
    // Ignore storage access errors
  }
}

function readCrossTabSyncMarker(): CrossTabSyncMarker | null {
  try {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    const raw = localStorage.getItem(AUTH_SYNC_MARKER_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<CrossTabSyncMarker> | null;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.at !== 'number' ||
      typeof parsed.senderId !== 'string' ||
      (parsed.kind !== 'uncertain' &&
        parsed.kind !== 'replay_detected' &&
        parsed.kind !== 'relogin_required')
    ) {
      return null;
    }
    return parsed as CrossTabSyncMarker;
  } catch {
    return null;
  }
}

/**
 * Coordinates single-flight refresh within the tab, bounded cross-tab Web Locks
 * serialization when supported, credential-free cross-tab uncertainty markers
 * + BroadcastChannel invalidation notifications, and operation-bound monotonic
 * generation fencing so stale async responses cannot restore a logged-out session.
 */
export class SessionCoordinator {
  private readonly tabId = createTabId();
  private inFlightRefresh: {
    generation: number;
    promise: Promise<RefreshSessionResult>;
  } | null = null;
  private generation = 0;
  private channel: BroadcastChannel | null = null;
  private callbacks: SessionCoordinatorCallbacks | null = null;

  public readonly crossTabSupported: boolean;

  constructor(callbacks?: SessionCoordinatorCallbacks) {
    this.crossTabSupported = isWebLocksSupported() && isBroadcastChannelSupported();
    this.ensureChannel();
    if (callbacks) {
      this.attachCallbacks(callbacks);
    }
  }

  private ensureChannel(): void {
    if (!this.channel && isBroadcastChannelSupported()) {
      this.channel = new BroadcastChannel(AUTH_BROADCAST_CHANNEL_NAME);
      this.channel.onmessage = (event: MessageEvent<unknown>) => {
        const msg = event.data as Partial<AuthBroadcastEvent> | null;
        if (!msg || typeof msg !== 'object' || msg.senderId === this.tabId) {
          return;
        }

        if (msg.type === 'LOGOUT') {
          this.bumpGeneration();
          this.callbacks?.onExternalLogout('logout');
        } else if (msg.type === 'LOGOUT_ALL') {
          this.bumpGeneration();
          this.callbacks?.onExternalLogout('logout_all');
        } else if (
          msg.type === 'SESSION_INVALIDATED' &&
          (msg.reason === 'replay_detected' ||
            msg.reason === 'relogin_required' ||
            msg.reason === 'uncertain_refresh')
        ) {
          this.bumpGeneration();
          this.callbacks?.onExternalInvalidation(msg.reason);
        }
      };
    }
  }

  public attachCallbacks(callbacks: SessionCoordinatorCallbacks): void {
    this.callbacks = callbacks;
    this.ensureChannel();
  }

  public dispose(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    this.callbacks = null;
  }

  public getGeneration(): number {
    return this.generation;
  }

  public bumpGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  private broadcast(event: AuthBroadcastEvent): void {
    if (!this.channel) {
      return;
    }
    try {
      this.channel.postMessage(event);
    } catch {
      // Ignore closed channel errors during teardown
    }
  }

  private propagateFailureOutcome(result: RefreshSessionResult): void {
    const useSyncMarker = isWebLocksSupported();

    if (result.kind === 'replay_detected') {
      if (useSyncMarker) {
        writeCrossTabSyncMarker({
          kind: 'replay_detected',
          at: Date.now(),
          senderId: this.tabId,
        });
      }
      this.broadcast({
        type: 'SESSION_INVALIDATED',
        senderId: this.tabId,
        reason: 'replay_detected',
      });
    } else if (result.kind === 'relogin_required') {
      if (useSyncMarker) {
        writeCrossTabSyncMarker({
          kind: 'relogin_required',
          at: Date.now(),
          senderId: this.tabId,
        });
      }
      this.broadcast({
        type: 'SESSION_INVALIDATED',
        senderId: this.tabId,
        reason: 'relogin_required',
      });
    } else if (result.kind === 'uncertain' || result.kind === 'invalid') {
      if (useSyncMarker) {
        writeCrossTabSyncMarker({
          kind: 'uncertain',
          at: Date.now(),
          senderId: this.tabId,
        });
      }
      this.broadcast({
        type: 'SESSION_INVALIDATED',
        senderId: this.tabId,
        reason: 'uncertain_refresh',
      });
    } else if (result.kind === 'authenticated') {
      if (useSyncMarker) {
        clearCrossTabSyncMarker();
      }
    }
  }

  private executeWithBoundedLock(
    opGeneration: number,
    options?: CoordinatorRefreshOptions,
  ): Promise<RefreshSessionResult> {
    if (options?.signal?.aborted) {
      return Promise.resolve({ kind: 'aborted' });
    }

    if (!isWebLocksSupported()) {
      if (this.generation !== opGeneration) {
        return Promise.resolve({ kind: 'aborted' });
      }
      return refreshSession(options);
    }

    const waitStartMs = Date.now();
    const lockTimeoutMs = options?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

    return new Promise<RefreshSessionResult>((resolve) => {
      let settled = false;
      let waiterCancelled = false;

      const finish = (res: RefreshSessionResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(lockTimer);
        options?.signal?.removeEventListener('abort', onPreLockAbort);
        resolve(res);
      };

      const onPreLockAbort = () => {
        waiterCancelled = true;
        finish({ kind: 'aborted' });
      };

      const lockTimer = setTimeout(() => {
        waiterCancelled = true;
        finish({
          kind: 'uncertain',
          reason: 'lock_timeout',
          error: `Timed out waiting for refresh lock after ${lockTimeoutMs}ms`,
        });
      }, lockTimeoutMs);

      options?.signal?.addEventListener('abort', onPreLockAbort, { once: true });

      Promise.resolve(
        navigator.locks.request(AUTH_REFRESH_LOCK_NAME, async () => {
          // Timed-out or cancelled waiters must never dispatch after lock acquisition.
          if (waiterCancelled || settled || this.generation !== opGeneration) {
            return { kind: 'aborted' } satisfies RefreshSessionResult;
          }

          // Lock acquired: pre-lock abort no longer applies; subsequent abort is handled by fetch.
          clearTimeout(lockTimer);
          options?.signal?.removeEventListener('abort', onPreLockAbort);

          // Synchronously check credential-free cross-tab marker inside the lock
          // so delayed BroadcastChannel delivery cannot cause a racing refresh.
          const marker = readCrossTabSyncMarker();
          if (marker && marker.senderId !== this.tabId && marker.at >= waitStartMs) {
            if (marker.kind === 'replay_detected') {
              return {
                kind: 'replay_detected',
                status: 401,
                error: 'Session replay detected in another tab; please sign in again',
              } satisfies RefreshSessionResult;
            }
            if (marker.kind === 'relogin_required') {
              return {
                kind: 'relogin_required',
                status: 403,
                error: 'Session invalidated in another tab; please sign in again',
              } satisfies RefreshSessionResult;
            }
            return {
              kind: 'uncertain',
              reason: 'network',
              error: 'Session refresh outcome uncertain in another tab; please sign in again',
            } satisfies RefreshSessionResult;
          }

          const res = await refreshSession(options);
          if (this.generation === opGeneration) {
            this.propagateFailureOutcome(res);
          }
          return res;
        }),
      )
        .then((res) => {
          finish(res);
        })
        .catch(() => {
          finish({
            kind: 'uncertain',
            reason: 'network',
            error: 'Failed to acquire refresh lock; session state uncertain',
          });
        });
    });
  }

  /**
   * Executes a single-flight session refresh.
   * Generation ownership is bound to the in-flight operation itself:
   * callers arriving after generation invalidation never accept an older
   * operation's result and do not automatically dispatch a replacement refresh.
   */
  public refresh(options?: CoordinatorRefreshOptions): Promise<{
    result: RefreshSessionResult;
    stale: boolean;
  }> {
    if (this.inFlightRefresh) {
      if (this.inFlightRefresh.generation !== this.generation) {
        return Promise.resolve({
          result: { kind: 'aborted' },
          stale: true,
        });
      }

      const joinedOp = this.inFlightRefresh;
      return joinedOp.promise.then((result) => ({
        result,
        stale: this.generation !== joinedOp.generation,
      }));
    }

    const opGeneration = this.generation;
    const promise = this.executeWithBoundedLock(opGeneration, options)
      .then((result) => {
        if (!isWebLocksSupported() && this.generation === opGeneration) {
          this.propagateFailureOutcome(result);
        }
        return result;
      })
      .finally(() => {
        if (this.inFlightRefresh?.promise === promise) {
          this.inFlightRefresh = null;
        }
      });

    this.inFlightRefresh = { generation: opGeneration, promise };

    return promise.then((result) => ({
      result,
      stale: this.generation !== opGeneration,
    }));
  }

  public async logout(
    options: AuthRequestOptions & { accessToken?: string | null } = {},
  ): Promise<LogoutResult> {
    const result = await logoutSession(options);

    if (
      result.kind === 'logged_out' ||
      result.kind === 'already_logged_out' ||
      result.kind === 'mismatch'
    ) {
      this.bumpGeneration();
    }

    if (result.kind === 'logged_out' || result.kind === 'already_logged_out') {
      clearCrossTabSyncMarker();
      this.broadcast({
        type: 'LOGOUT',
        senderId: this.tabId,
      });
    } else if (result.kind === 'mismatch') {
      writeCrossTabSyncMarker({
        kind: 'relogin_required',
        at: Date.now(),
        senderId: this.tabId,
      });
      this.broadcast({
        type: 'SESSION_INVALIDATED',
        senderId: this.tabId,
        reason: 'relogin_required',
      });
    }

    return result;
  }

  public async logoutAll(
    options: AuthRequestOptions & { accessToken: string },
  ): Promise<LogoutAllResult> {
    const result = await logoutAllSessions(options);

    if (result.kind === 'logged_out_all' || result.kind === 'unauthenticated') {
      this.bumpGeneration();
      clearCrossTabSyncMarker();
      this.broadcast({
        type: 'LOGOUT_ALL',
        senderId: this.tabId,
      });
    }

    return result;
  }
}
