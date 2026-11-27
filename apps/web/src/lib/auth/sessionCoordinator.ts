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

export type CrossTabSyncStatus =
  | 'in_progress'
  | 'uncertain'
  | 'replay_detected'
  | 'relogin_required';

interface CrossTabSyncMarker {
  status: CrossTabSyncStatus;
  at: number;
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

function writeCrossTabSyncMarker(marker: CrossTabSyncMarker): boolean {
  try {
    if (typeof localStorage === 'undefined') {
      return false;
    }
    localStorage.setItem(AUTH_SYNC_MARKER_KEY, JSON.stringify(marker));
    return true;
  } catch {
    return false;
  }
}

function clearCrossTabSyncMarker(): boolean {
  try {
    if (typeof localStorage === 'undefined') {
      return false;
    }
    localStorage.removeItem(AUTH_SYNC_MARKER_KEY);
    return true;
  } catch {
    return false;
  }
}

function readCrossTabSyncMarker(): {
  ok: true;
  marker: CrossTabSyncMarker | null;
} | {
  ok: false;
} {
  try {
    if (typeof localStorage === 'undefined') {
      return { ok: false };
    }
    const raw = localStorage.getItem(AUTH_SYNC_MARKER_KEY);
    if (!raw) {
      return { ok: true, marker: null };
    }
    const parsed = JSON.parse(raw) as Partial<CrossTabSyncMarker> | null;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.at !== 'number' ||
      (parsed.status !== 'in_progress' &&
        parsed.status !== 'uncertain' &&
        parsed.status !== 'replay_detected' &&
        parsed.status !== 'relogin_required')
    ) {
      // Corrupt marker is treated conservatively as unresolved uncertainty.
      return { ok: true, marker: { status: 'uncertain', at: Date.now() } };
    }
    return { ok: true, marker: parsed as CrossTabSyncMarker };
  } catch {
    return { ok: false };
  }
}

function markerToBlockedResult(status: CrossTabSyncStatus): RefreshSessionResult {
  if (status === 'replay_detected') {
    return {
      kind: 'replay_detected',
      status: 401,
      error: 'Session replay detected; please sign in again.',
    };
  }
  if (status === 'relogin_required') {
    return {
      kind: 'relogin_required',
      status: 403,
      error: 'Session requires reauthentication; please sign in again.',
    };
  }
  if (status === 'in_progress') {
    return {
      kind: 'uncertain',
      reason: 'interrupted_rotation',
      error: 'Previous session rotation was interrupted or unresolved; please sign in again.',
    };
  }
  return {
    kind: 'uncertain',
    reason: 'network',
    error: 'Previous session refresh outcome is unresolved; please sign in again.',
  };
}

/**
 * Coordinates single-flight refresh within the tab, bounded cross-tab Web Locks
 * serialization when supported, credential-free persistent rotation/uncertainty
 * markers + BroadcastChannel invalidation notifications, and operation-bound
 * monotonic generation fencing so stale async responses cannot restore a
 * logged-out session.
 *
 * Integration requirement for future explicit-login tickets (P2-FE-03 / P2-AUTH-02 / P2-AUTH-03b):
 * Call `acknowledgeExplicitAuthentication()` ONLY after a verified `200 SessionResponse`
 * from an explicit fresh login or Google exchange so any unresolved refresh-uncertainty
 * marker from an earlier session is safely cleared.
 */
export class SessionCoordinator {
  private readonly tabId = createTabId();
  private inFlightRefresh: {
    generation: number;
    promise: Promise<RefreshSessionResult>;
  } | null = null;
  private generation = 0;
  private inMemoryUnresolvedState: CrossTabSyncStatus | null = null;
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
          this.inMemoryUnresolvedState = null;
          this.bumpGeneration();
          this.callbacks?.onExternalLogout('logout');
        } else if (msg.type === 'LOGOUT_ALL') {
          this.inMemoryUnresolvedState = null;
          this.bumpGeneration();
          this.callbacks?.onExternalLogout('logout_all');
        } else if (
          msg.type === 'SESSION_INVALIDATED' &&
          (msg.reason === 'replay_detected' ||
            msg.reason === 'relogin_required' ||
            msg.reason === 'uncertain_refresh')
        ) {
          this.inMemoryUnresolvedState =
            msg.reason === 'uncertain_refresh' ? 'uncertain' : msg.reason;
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

  /**
   * Clears unresolved uncertainty only after an explicit fresh authentication
   * succeeds (reserved for future login/Google-exchange tickets).
   */
  public acknowledgeExplicitAuthentication(): void {
    this.inMemoryUnresolvedState = null;
    if (isWebLocksSupported()) {
      clearCrossTabSyncMarker();
    }
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

  private resolveRotationMarker(
    result: RefreshSessionResult,
    usePersistentMarker: boolean,
  ): void {
    if (result.kind === 'authenticated' || result.kind === 'unauthenticated') {
      // Definitive server outcome: active session restored or server confirmed no session.
      this.inMemoryUnresolvedState = null;
      if (usePersistentMarker) {
        clearCrossTabSyncMarker();
      }
      return;
    }

    if (result.kind === 'replay_detected') {
      this.inMemoryUnresolvedState = 'replay_detected';
      if (usePersistentMarker) {
        writeCrossTabSyncMarker({ status: 'replay_detected', at: Date.now() });
      }
      this.broadcast({
        type: 'SESSION_INVALIDATED',
        senderId: this.tabId,
        reason: 'replay_detected',
      });
      return;
    }

    if (result.kind === 'relogin_required') {
      this.inMemoryUnresolvedState = 'relogin_required';
      if (usePersistentMarker) {
        writeCrossTabSyncMarker({ status: 'relogin_required', at: Date.now() });
      }
      this.broadcast({
        type: 'SESSION_INVALIDATED',
        senderId: this.tabId,
        reason: 'relogin_required',
      });
      return;
    }

    if (result.kind === 'uncertain' || result.kind === 'invalid') {
      this.inMemoryUnresolvedState = 'uncertain';
      if (usePersistentMarker) {
        writeCrossTabSyncMarker({ status: 'uncertain', at: Date.now() });
      }
      this.broadcast({
        type: 'SESSION_INVALIDATED',
        senderId: this.tabId,
        reason: 'uncertain_refresh',
      });
    }
  }

  private executeWithBoundedLock(
    opGeneration: number,
    options?: CoordinatorRefreshOptions,
  ): Promise<RefreshSessionResult> {
    if (options?.signal?.aborted) {
      return Promise.resolve({ kind: 'aborted' });
    }

    if (this.inMemoryUnresolvedState) {
      return Promise.resolve(markerToBlockedResult(this.inMemoryUnresolvedState));
    }

    if (!isWebLocksSupported()) {
      if (this.generation !== opGeneration) {
        return Promise.resolve({ kind: 'aborted' });
      }
      return refreshSession(options);
    }

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

          clearTimeout(lockTimer);
          options?.signal?.removeEventListener('abort', onPreLockAbort);

          if (this.inMemoryUnresolvedState) {
            return markerToBlockedResult(this.inMemoryUnresolvedState);
          }

          // Synchronously read persistent coordination marker inside the lock.
          // Unresolved markers block originating tab, newly opened tabs, and reloads.
          const readResult = readCrossTabSyncMarker();
          if (!readResult.ok) {
            return {
              kind: 'uncertain',
              reason: 'coordination_storage_unavailable',
              error:
                'Cross-tab coordination storage is unavailable; please sign in again.',
            } satisfies RefreshSessionResult;
          }

          if (readResult.marker) {
            this.inMemoryUnresolvedState = readResult.marker.status;
            return markerToBlockedResult(readResult.marker.status);
          }

          // Persist credential-free in-progress rotation marker before dispatch.
          const wroteInProgress = writeCrossTabSyncMarker({
            status: 'in_progress',
            at: Date.now(),
          });
          if (!wroteInProgress) {
            return {
              kind: 'uncertain',
              reason: 'coordination_storage_unavailable',
              error:
                'Failed to persist rotation coordination marker; please sign in again.',
            } satisfies RefreshSessionResult;
          }

          const res = await refreshSession(options);
          if (this.generation === opGeneration) {
            this.resolveRotationMarker(res, true);
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
          this.resolveRotationMarker(result, false);
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
      // Confirmed safe session reset clears unresolved uncertainty.
      this.inMemoryUnresolvedState = null;
      if (isWebLocksSupported()) {
        clearCrossTabSyncMarker();
      }
      this.broadcast({
        type: 'LOGOUT',
        senderId: this.tabId,
      });
    } else if (result.kind === 'mismatch') {
      this.inMemoryUnresolvedState = 'relogin_required';
      if (isWebLocksSupported()) {
        writeCrossTabSyncMarker({ status: 'relogin_required', at: Date.now() });
      }
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
      // Confirmed safe session reset clears unresolved uncertainty.
      this.inMemoryUnresolvedState = null;
      if (isWebLocksSupported()) {
        clearCrossTabSyncMarker();
      }
      this.broadcast({
        type: 'LOGOUT_ALL',
        senderId: this.tabId,
      });
    }

    return result;
  }
}
