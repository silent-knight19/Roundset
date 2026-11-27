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
      reason: 'replay_detected' | 'relogin_required';
    };

export interface SessionCoordinatorCallbacks {
  onExternalLogout: (reason: 'logout' | 'logout_all') => void;
  onExternalInvalidation: (reason: 'replay_detected' | 'relogin_required') => void;
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

/**
 * Coordinates single-flight refresh within the tab, cross-tab Web Locks
 * serialization when supported, BroadcastChannel invalidation notifications
 * (without transmitting any credential material), and monotonic generation
 * fencing so stale async responses cannot restore a logged-out session.
 */
export class SessionCoordinator {
  private readonly tabId = createTabId();
  private inFlightRefresh: Promise<RefreshSessionResult> | null = null;
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
          (msg.reason === 'replay_detected' || msg.reason === 'relogin_required')
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

  /**
   * Executes a single-flight session refresh.
   * Reads the current CSRF cookie *inside* the Web Lock (not before acquiring it)
   * so concurrent tabs see updated cookies from the preceding rotation.
   */
  public refresh(options?: AuthRequestOptions): Promise<{
    result: RefreshSessionResult;
    stale: boolean;
  }> {
    const startGeneration = this.generation;

    if (!this.inFlightRefresh) {
      const executeInsideLock = async (): Promise<RefreshSessionResult> => {
        if (isWebLocksSupported()) {
          return navigator.locks.request(AUTH_REFRESH_LOCK_NAME, async () => {
            if (this.generation !== startGeneration) {
              return { kind: 'aborted' };
            }
            return refreshSession(options);
          });
        }
        return refreshSession(options);
      };

      const promise = executeInsideLock().finally(() => {
        if (this.inFlightRefresh === promise) {
          this.inFlightRefresh = null;
        }
      });

      this.inFlightRefresh = promise;
    }

    return this.inFlightRefresh.then((result) => {
      const stale = this.generation !== startGeneration;
      if (!stale && result.kind === 'replay_detected') {
        this.broadcast({
          type: 'SESSION_INVALIDATED',
          senderId: this.tabId,
          reason: 'replay_detected',
        });
      } else if (!stale && result.kind === 'relogin_required') {
        this.broadcast({
          type: 'SESSION_INVALIDATED',
          senderId: this.tabId,
          reason: 'relogin_required',
        });
      }
      return { result, stale };
    });
  }

  public async logout(
    options: AuthRequestOptions & { accessToken?: string | null } = {},
  ): Promise<LogoutResult> {
    const result = await logoutSession(options);

    // On 403 credential/session mismatch, backend did NOT revoke session or clear cookies.
    if (result.kind === 'logged_out' || result.kind === 'already_logged_out') {
      this.bumpGeneration();
      this.broadcast({
        type: 'LOGOUT',
        senderId: this.tabId,
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
      this.broadcast({
        type: 'LOGOUT_ALL',
        senderId: this.tabId,
      });
    }

    return result;
  }
}
