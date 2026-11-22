import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { Logger } from 'pino';
import { MongoManager } from '../src/integrations/mongodb.js';

interface LogEntry {
  level: string;
  obj?: unknown;
  msg?: string;
}

function createRecordingLogger(): { logger: Logger; logs: LogEntry[] } {
  const logs: LogEntry[] = [];

  const record = (level: string, arg1?: unknown, arg2?: unknown) => {
    if (typeof arg1 === 'string') {
      logs.push({ level, msg: arg1 });
    } else {
      logs.push({ level, obj: arg1, msg: typeof arg2 === 'string' ? arg2 : undefined });
    }
  };

  const dummyLogger = {
    info: (arg1?: unknown, arg2?: unknown) => record('info', arg1, arg2),
    warn: (arg1?: unknown, arg2?: unknown) => record('warn', arg1, arg2),
    error: (arg1?: unknown, arg2?: unknown) => record('error', arg1, arg2),
    fatal: (arg1?: unknown, arg2?: unknown) => record('fatal', arg1, arg2),
    debug: (arg1?: unknown, arg2?: unknown) => record('debug', arg1, arg2),
    trace: (arg1?: unknown, arg2?: unknown) => record('trace', arg1, arg2),
    child: () => dummyLogger,
  } as unknown as Logger;

  return { logger: dummyLogger, logs };
}

describe('MongoDB Diagnostic Logging Security & Lifecycle (R1-01, R2-04)', () => {
  const FAKE_USER = 'super_secret_agent_user';
  const FAKE_PASSWORD = 'TopSecretP@ssw0rd!987';
  const FAKE_HOST = 'fake-cluster-999.mongodb.net';
  const FAKE_URI = `mongodb+srv://${FAKE_USER}:${FAKE_PASSWORD}@${FAKE_HOST}/testdb?authSource=admin&w=majority`;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('R1-01: Does not serialize URI, credentials, or raw driver error messages on connection failure', async () => {
    const { logger, logs } = createRecordingLogger();
    const mongoManager = new MongoManager(logger);

    // Synthetic connection failure containing recognizable fake credentials in the exception message
    const syntheticDriverError = new Error(
      `MongoServerError: bad auth : authentication failed for user ${FAKE_USER} with pass ${FAKE_PASSWORD} at ${FAKE_URI}`
    );

    vi.spyOn(mongoose, 'connect').mockRejectedValueOnce(syntheticDriverError);

    const connected = await mongoManager.connect(FAKE_URI);
    expect(connected).toBe(false);

    // Verify all captured logs
    const serializedLogs = JSON.stringify(logs);

    // Critical assertion: none of the credentials, host, raw URI, or driver error message must appear
    expect(serializedLogs).not.toContain(FAKE_USER);
    expect(serializedLogs).not.toContain(FAKE_PASSWORD);
    expect(serializedLogs).not.toContain(FAKE_HOST);
    expect(serializedLogs).not.toContain(FAKE_URI);
    expect(serializedLogs).not.toContain('MongoServerError');
    expect(serializedLogs).not.toContain('bad auth');
    expect(serializedLogs).not.toContain('authentication failed');

    // Safe metadata assertion
    const failureLog = logs.find((l) => l.level === 'error');
    expect(failureLog).toBeDefined();
    expect(failureLog?.obj).toEqual({
      state: 'failed',
      category: 'DATABASE_CONNECTION_TIMEOUT',
    });
    expect(failureLog?.msg).toBe('Database connection attempt failed within bounded timeout');

    const connectingLog = logs.find((l) => l.level === 'info');
    expect(connectingLog).toBeDefined();
    expect(connectingLog?.obj).toEqual({
      state: 'connecting',
      category: 'DATABASE_LIFECYCLE',
    });
    expect(connectingLog?.msg).toBe('Database connection attempt initiated');

    await mongoManager.disconnect();
  });

  it('R1-01: Runtime error events log fixed diagnostic category without serializing error objects', async () => {
    const { logger, logs } = createRecordingLogger();
    const mongoManager = new MongoManager(logger);

    // Trigger fake runtime error event on connection
    const syntheticRuntimeError = new Error(
      `Driver crash with internal password=${FAKE_PASSWORD} on ${FAKE_URI}`
    );

    mongoManager.connection.emit('error', syntheticRuntimeError);

    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(FAKE_PASSWORD);
    expect(serializedLogs).not.toContain(FAKE_URI);
    expect(serializedLogs).not.toContain('Driver crash');

    const errorLog = logs.find((l) => l.level === 'error');
    expect(errorLog).toBeDefined();
    expect(errorLog?.obj).toEqual({
      state: 'error',
      category: 'DATABASE_RUNTIME_ERROR',
    });
    expect(errorLog?.msg).toBe('Database runtime error occurred');

    await mongoManager.disconnect();
  });

  it('R1-01: Disconnect errors log fixed category without exposing error exceptions', async () => {
    const { logger, logs } = createRecordingLogger();
    const mongoManager = new MongoManager(logger);

    // Mock readyState to indicate connected so disconnect executes
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    vi.spyOn(mongoose, 'disconnect').mockRejectedValueOnce(
      new Error(`Disconnect exception with sensitive secret ${FAKE_PASSWORD}`)
    );

    await mongoManager.disconnect();

    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(FAKE_PASSWORD);
    expect(serializedLogs).not.toContain('Disconnect exception');

    const errorLog = logs.find((l) => l.level === 'error');
    expect(errorLog).toBeDefined();
    expect(errorLog?.obj).toEqual({
      state: 'disconnect_error',
      category: 'DATABASE_DISCONNECT_ERROR',
    });
    expect(errorLog?.msg).toBe('Error during database disconnect');
  });

  it('R2-04: Listener counts remain stable after repeated manager creation and cleanup', async () => {
    const initialDisconnectedCount = mongoose.connection.listenerCount('disconnected');
    const initialReconnectedCount = mongoose.connection.listenerCount('reconnected');
    const initialErrorCount = mongoose.connection.listenerCount('error');

    // Install an unrelated listener to verify it is never touched
    const unrelatedListener = () => {};
    mongoose.connection.on('disconnected', unrelatedListener);
    expect(mongoose.connection.listenerCount('disconnected')).toBe(initialDisconnectedCount + 1);

    // Repeatedly create and cleanup MongoManager instances
    for (let i = 0; i < 5; i++) {
      const manager = new MongoManager();
      expect(mongoose.connection.listenerCount('disconnected')).toBe(initialDisconnectedCount + 2);
      expect(mongoose.connection.listenerCount('reconnected')).toBe(initialReconnectedCount + 1);
      expect(mongoose.connection.listenerCount('error')).toBe(initialErrorCount + 1);

      await manager.disconnect();

      // Counts return exactly to baseline (+ unrelated listener)
      expect(mongoose.connection.listenerCount('disconnected')).toBe(initialDisconnectedCount + 1);
      expect(mongoose.connection.listenerCount('reconnected')).toBe(initialReconnectedCount);
      expect(mongoose.connection.listenerCount('error')).toBe(initialErrorCount);
    }

    // Unrelated listener was retained throughout
    expect(mongoose.connection.listeners('disconnected')).toContain(unrelatedListener);

    // Clean up unrelated listener
    mongoose.connection.removeListener('disconnected', unrelatedListener);
    expect(mongoose.connection.listenerCount('disconnected')).toBe(initialDisconnectedCount);
  });
});
