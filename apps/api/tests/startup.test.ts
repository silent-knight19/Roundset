import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { startServer, type RunningServer } from '../src/server.js';
import { loadEnv } from '../src/config/env.js';
import type { ReadinessProvider } from '../src/core/readiness.js';

class DelayedMongoManager {
  private connected = false;
  private resolveConnection!: (val: boolean) => void;
  public readonly connectionPromise: Promise<boolean>;

  constructor() {
    this.connectionPromise = new Promise((resolve) => {
      this.resolveConnection = resolve;
    });
  }

  public async connect(_uri: string): Promise<boolean> {
    const result = await this.connectionPromise;
    this.connected = result;
    return result;
  }

  public completeConnection(success = true): void {
    this.resolveConnection(success);
  }

  public getReadinessProvider(): ReadinessProvider {
    return {
      isReady: () => this.connected,
      isMock: false,
    };
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
  }
}

describe('Server Startup & Liveness Independence (R1-02)', () => {
  let runningServer: RunningServer | null = null;

  afterEach(async () => {
    if (runningServer) {
      await runningServer.stop();
      runningServer = null;
    }
  });

  it('R1-02: Liveness is available immediately while MongoDB connection is still pending', async () => {
    const delayedManager = new DelayedMongoManager();

    const env = loadEnv({
      NODE_ENV: 'development',
      PORT: 8787,
      WEB_ORIGIN: 'http://localhost:5173',
      MOCK_DATABASE: false,
      MONGODB_URI: 'mongodb://localhost:27017/delayed_test_db',
    });

    // Start server with injected delayed mongo manager on ephemeral port 0
    runningServer = await startServer({
      env,
      mongoManager: delayedManager,
      port: 0,
    });

    // 1. Assert liveness is available immediately while DB connection is pending
    const liveResponse = await request(runningServer.server).get('/api/v1/health/live');
    expect(liveResponse.status).toBe(200);
    expect(liveResponse.body.data.status).toBe('ok');
    expect(liveResponse.body.meta.requestId).toBeDefined();

    // 2. Assert readiness returns 503 while DB connection is pending
    const readyPendingResponse = await request(runningServer.server).get('/api/v1/health/ready');
    expect(readyPendingResponse.status).toBe(503);
    expect(readyPendingResponse.body.data.ready).toBe(false);

    // 3. Resolve the delayed connection
    delayedManager.completeConnection(true);
    await delayedManager.connectionPromise;

    // 4. Assert readiness transitions to 200 after connection establishes
    const readyResolvedResponse = await request(runningServer.server).get('/api/v1/health/ready');
    expect(readyResolvedResponse.status).toBe(200);
    expect(readyResolvedResponse.body.data.ready).toBe(true);
  });

  it('R1-02: Liveness remains available even if database connection fails', async () => {
    const delayedManager = new DelayedMongoManager();

    const env = loadEnv({
      NODE_ENV: 'development',
      PORT: 8787,
      WEB_ORIGIN: 'http://localhost:5173',
      MOCK_DATABASE: false,
      MONGODB_URI: 'mongodb://localhost:27017/failing_test_db',
    });

    runningServer = await startServer({
      env,
      mongoManager: delayedManager,
      port: 0,
    });

    // Fail the connection attempt
    delayedManager.completeConnection(false);
    await delayedManager.connectionPromise;

    // Liveness must remain healthy (200)
    const liveResponse = await request(runningServer.server).get('/api/v1/health/live');
    expect(liveResponse.status).toBe(200);
    expect(liveResponse.body.data.status).toBe('ok');

    // Readiness must remain false (503)
    const readyResponse = await request(runningServer.server).get('/api/v1/health/ready');
    expect(readyResponse.status).toBe(503);
    expect(readyResponse.body.data.ready).toBe(false);
  });

  it('R1-02: Graceful shutdown is safe when connection attempt is still pending', async () => {
    const delayedManager = new DelayedMongoManager();

    const env = loadEnv({
      NODE_ENV: 'development',
      PORT: 8787,
      WEB_ORIGIN: 'http://localhost:5173',
      MOCK_DATABASE: false,
      MONGODB_URI: 'mongodb://localhost:27017/pending_shutdown_db',
    });

    runningServer = await startServer({
      env,
      mongoManager: delayedManager,
      port: 0,
    });

    // Stop server while connection is still unresolved
    await runningServer.stop();
    runningServer = null;

    // Safe resolution after shutdown without crashing
    delayedManager.completeConnection(false);
  });
});
