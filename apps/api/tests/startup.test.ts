import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import net from 'node:net';
import mongoose from 'mongoose';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer } from '../src/server.js';
import { loadEnv } from '../src/config/env.js';
import { createLogger } from '../src/core/logging.js';
import { MongoManager } from '../src/integrations/mongodb.js';
import type { ReadinessProvider } from '../src/core/readiness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

describe('Server Startup & Lifecycle Hardening (R1-02, R2-01, R2-02, R2-03)', () => {
  let runningServer: RunningServer | null = null;

  afterEach(async () => {
    if (runningServer) {
      await runningServer.stop();
      runningServer = null;
    }
  });

  it('R2-01: Importing API module in a separate process without test env vars does not start an HTTP server', async () => {
    const script = `
      import * as api from './src/index.js';
      import * as server from './src/server.js';
      console.log('IMPORTED_WITHOUT_STARTING_SERVER');
    `;

    const repoRoot = path.resolve(__dirname, '../../..');

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '-e', script],
      {
        cwd: path.resolve(repoRoot, 'apps/api'),
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'production',
          PORT: '8787',
          // Explicitly delete test-runner environment variables
          VITEST: undefined,
          NODE_TEST_CONTEXT: undefined,
        },
      }
    );

    let output = '';
    child.stdout?.on('data', (d) => { output += d.toString(); });
    child.stderr?.on('data', (d) => { output += d.toString(); });

    const exitCode = await new Promise<number>((resolve) => {
      child.on('close', resolve);
    });

    expect(exitCode).toBe(0);
    expect(output).toContain('IMPORTED_WITHOUT_STARTING_SERVER');
    expect(output).not.toContain('API service listening');
  });

  it('R2-02 & R3-02: Rejects startup cleanly on EADDRINUSE, cleans up manager-owned listeners, preserves external listeners, and skips database connection', async () => {
    // 1. Occupy an ephemeral port with a raw net server
    const blockerServer = net.createServer();
    const occupiedPort = await new Promise<number>((resolve) => {
      blockerServer.listen(0, () => {
        const addr = blockerServer.address() as net.AddressInfo;
        resolve(addr.port);
      });
    });

    // 2. Register an unrelated external listener on mongoose.connection to verify isolation
    const externalListener = () => {};
    mongoose.connection.on('disconnected', externalListener);
    const baselineDisconnectedCount = mongoose.connection.listenerCount('disconnected');
    const baselineReconnectedCount = mongoose.connection.listenerCount('reconnected');
    const baselineErrorCount = mongoose.connection.listenerCount('error');

    // 3. Create test-controlled MongoManager
    const mongoManager = new MongoManager();
    const connectSpy = vi.spyOn(mongoManager, 'connect');

    // Listeners are attached to mongoose.connection upon creation (+1 each)
    expect(mongoose.connection.listenerCount('disconnected')).toBe(baselineDisconnectedCount + 1);

    const env = loadEnv({
      NODE_ENV: 'development',
      PORT: 8787,
      WEB_ORIGIN: 'http://localhost:5173',
      MOCK_DATABASE: false,
      MONGODB_URI: 'mongodb://localhost:27017/eaddrinuse_db',
    });

    // 4. Attempt startup on occupied port - must reject cleanly
    await expect(
      startServer({
        env,
        mongoManager,
        port: occupiedPort,
      })
    ).rejects.toThrow();

    // 5. Verification:
    // a) No database connection attempt was made
    expect(connectSpy).not.toHaveBeenCalled();

    // b) Manager-owned listeners were cleanly removed
    expect(mongoose.connection.listenerCount('disconnected')).toBe(baselineDisconnectedCount);
    expect(mongoose.connection.listenerCount('reconnected')).toBe(baselineReconnectedCount);
    expect(mongoose.connection.listenerCount('error')).toBe(baselineErrorCount);

    // c) Unrelated external listener is still registered
    expect(mongoose.connection.listeners('disconnected')).toContain(externalListener);

    // Clean up
    mongoose.connection.removeListener('disconnected', externalListener);
    await new Promise<void>((resolve) => blockerServer.close(() => resolve()));
  });

  it('R2-03: Repeated calls to stop() are safe and idempotent', async () => {
    const env = loadEnv({
      NODE_ENV: 'development',
      PORT: 8787,
      WEB_ORIGIN: 'http://localhost:5173',
    });

    runningServer = await startServer({ env, port: 0 });

    // First stop
    await expect(runningServer.stop()).resolves.toBeUndefined();
    // Second stop (idempotent)
    await expect(runningServer.stop()).resolves.toBeUndefined();
    // Third stop (idempotent)
    await expect(runningServer.stop()).resolves.toBeUndefined();

    runningServer = null;
  });

  it('R1-02 & R2-03: Liveness is available immediately while MongoDB connection is still pending', async () => {
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

    // 3. Resolve delayed connection
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

  it('R1-02 & R2-03: Graceful shutdown is safe when connection attempt is still pending', async () => {
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

  it('CodeQL: Server startup logs use fixed category and message without leaking environment-derived values', async () => {
    const capturedLogChunks: string[] = [];
    const destinationStream = {
      write(chunk: string) {
        capturedLogChunks.push(chunk);
      },
    };

    const pinoLogger = createLogger(
      { level: 'trace' },
      destinationStream as unknown as import('pino').DestinationStream
    );

    const testWebOrigin = 'https://sensitive-origin-secret.example.com';
    const testPort = 8999;
    const env = loadEnv({
      NODE_ENV: 'development',
      PORT: testPort,
      WEB_ORIGIN: testWebOrigin,
      MOCK_DATABASE: true,
    });

    runningServer = await startServer({
      env,
      logger: pinoLogger,
      port: 0,
    });

    const completeLogOutput = capturedLogChunks.join('');

    // Assert safe lifecycle message was logged
    expect(completeLogOutput).toContain('API service listening');
    expect(completeLogOutput).toContain('SERVER_LIFECYCLE');

    // Assert environment-derived values do NOT appear anywhere in the captured logs
    expect(completeLogOutput).not.toContain(testWebOrigin);
    expect(completeLogOutput).not.toContain('https://sensitive-origin-secret.example.com');
    expect(completeLogOutput).not.toContain('webOrigin');
    expect(completeLogOutput).not.toContain('nodeEnv');
    expect(completeLogOutput).not.toContain('mockDatabase');

    // Parse the JSON log lines to strictly assert the schema of the listening log entry
    const parsedLogs = capturedLogChunks
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((log): log is Record<string, unknown> => log !== null);

    const listeningLog = parsedLogs.find(
      (log) => log.category === 'SERVER_LIFECYCLE' && log.msg === 'API service listening'
    );
    expect(listeningLog).toBeDefined();
    expect(listeningLog).not.toHaveProperty('webOrigin');
    expect(listeningLog).not.toHaveProperty('nodeEnv');
    expect(listeningLog).not.toHaveProperty('mockDatabase');
    expect(listeningLog).not.toHaveProperty('port');
  });
});
