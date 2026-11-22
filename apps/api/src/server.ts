import type { Server } from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { createApp } from './app.js';
import { loadEnv, type AppConfig } from './config/env.js';
import { createLogger } from './core/logging.js';
import { MongoManager } from './integrations/mongodb.js';
import { MockReadinessProvider, type ReadinessProvider } from './core/readiness.js';

export const ALLOWLISTED_ERROR_CODES = new Set([
  'EADDRINUSE',
  'EACCES',
  'EADDRNOTAVAIL',
  'EINVAL',
]);

export interface StartServerOptions {
  env?: AppConfig;
  logger?: Logger;
  mongoManager?: {
    connect(uri: string): Promise<boolean>;
    disconnect(): Promise<void>;
    getReadinessProvider(): ReadinessProvider;
    removeConnectionListeners?(): void;
  };
  readinessProvider?: ReadinessProvider;
  port?: number;
}

export interface RunningServer {
  server: Server;
  port: number;
  readinessProvider: ReadinessProvider;
  stop: () => Promise<void>;
}

/**
 * Checks whether the current module was directly executed as the application entrypoint.
 * Does not rely on test environment variables.
 */
export function isDirectEntry(metaUrl: string = import.meta.url): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    const scriptPath = fs.realpathSync(process.argv[1]);
    const modulePath = fs.realpathSync(fileURLToPath(metaUrl));
    return scriptPath === modulePath;
  } catch {
    return false;
  }
}

/**
 * Boots the HTTP application server following the mandated startup sequence:
 * 1. Load and validate configuration.
 * 2. Create the readiness provider, initially unready in real database mode.
 * 3. Create the Express application.
 * 4. Start the HTTP listener (with controlled error handling for EADDRINUSE).
 * 5. Initiate the bounded MongoDB connection attempt without blocking HTTP startup.
 * 6. Set readiness to true only when Mongoose reports a connected state.
 * 7. Keep liveness available if the connection fails.
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  // 1. Load and validate configuration
  const config = options.env ?? loadEnv();
  const logger = options.logger ?? createLogger();

  let mongoManager = options.mongoManager ?? null;
  let readinessProvider: ReadinessProvider;

  // 2. Create readiness provider, initially unready in real database mode
  if (config.MOCK_DATABASE) {
    logger.warn({ category: 'CONFIG' }, '[DEVELOPMENT MOCK] MOCK_DATABASE=true is active. Mock readiness enabled.');
    readinessProvider = options.readinessProvider ?? new MockReadinessProvider(true);
  } else if (config.MONGODB_URI) {
    if (!mongoManager) {
      mongoManager = new MongoManager(logger);
    }
    readinessProvider = options.readinessProvider ?? mongoManager.getReadinessProvider();
  } else {
    logger.warn({ category: 'CONFIG' }, 'MONGODB_URI is not set; running in offline development mode (readiness=false)');
    readinessProvider = options.readinessProvider ?? new MockReadinessProvider(false);
  }

  // 3. Create Express application
  const app = createApp({
    env: config,
    logger,
    readinessProvider,
  });

  const listenPort = options.port ?? config.PORT;

  // 4. Start HTTP listener with controlled error handling
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(listenPort);

    const onError = (err: Error) => {
      s.removeListener('listening', onListening);

      // R3-02: Release manager-owned connection listeners when HTTP startup fails
      if (
        mongoManager &&
        'removeConnectionListeners' in mongoManager &&
        typeof mongoManager.removeConnectionListeners === 'function'
      ) {
        mongoManager.removeConnectionListeners();
      }

      const rawCode = (err as NodeJS.ErrnoException).code;
      const code = rawCode && ALLOWLISTED_ERROR_CODES.has(rawCode) ? rawCode : undefined;

      logger.error(
        {
          category: 'SERVER_STARTUP_ERROR',
          ...(code ? { code } : {}),
        },
        'HTTP server startup failed'
      );
      reject(err);
    };

    const onListening = () => {
      s.removeListener('error', onError);
      const address = s.address();
      const boundPort = typeof address === 'object' && address ? address.port : listenPort;
      logger.info(
        {
          port: boundPort,
          nodeEnv: config.NODE_ENV,
          webOrigin: config.WEB_ORIGIN,
          mockDatabase: config.MOCK_DATABASE,
          category: 'SERVER_LIFECYCLE',
        },
        `API service listening on port ${boundPort}`
      );
      resolve(s);
    };

    s.once('error', onError);
    s.once('listening', onListening);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : listenPort;

  // 5. Initiate bounded MongoDB connection attempt without blocking HTTP startup
  // (Only executed if HTTP listener succeeded; skipped on listen error)
  if (mongoManager && config.MONGODB_URI) {
    mongoManager.connect(config.MONGODB_URI).catch(() => {
      // Handled internally in mongoManager without throwing
    });
  }

  // Bounded and idempotent stop method
  let isStopped = false;
  let stopPromise: Promise<void> | null = null;

  const stop = async (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }

    stopPromise = (async () => {
      if (isStopped) return;
      isStopped = true;

      // Close HTTP listener if still open
      await new Promise<void>((resolve) => {
        if (server.listening) {
          server.close((err) => {
            if (err) {
              logger.error(
                { category: 'SERVER_SHUTDOWN_ERROR' },
                'Error occurred during HTTP server close'
              );
            } else {
              logger.info(
                { category: 'SERVER_LIFECYCLE' },
                'HTTP server closed; disconnecting dependencies'
              );
            }
            resolve();
          });
        } else {
          resolve();
        }
      });

      // Disconnect database dependencies
      if (mongoManager) {
        try {
          await mongoManager.disconnect();
        } catch {
          logger.error(
            { category: 'DATABASE_DISCONNECT_ERROR' },
            'Error occurred during database disconnect'
          );
        }
      }
    })();

    return stopPromise;
  };

  return {
    server,
    port: actualPort,
    readinessProvider,
    stop,
  };
}

// Standalone execution: Attach process lifecycle signal handlers with 10s shutdown window
if (isDirectEntry(import.meta.url)) {
  const logger = createLogger();

  startServer({ logger })
    .then((runningServer) => {
      let isShuttingDown = false;
      const gracefulShutdown = async (signal: string) => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        logger.info(
          { signal, category: 'SERVER_LIFECYCLE' },
          'Received termination signal, initiating graceful shutdown...'
        );

        // Enforce 10-second maximum graceful-shutdown window for standalone process
        const forceExitTimer = setTimeout(() => {
          logger.error(
            { category: 'SERVER_SHUTDOWN_TIMEOUT' },
            'Graceful shutdown timed out; forcing exit'
          );
          process.exit(1);
        }, 10000);
        forceExitTimer.unref();

        try {
          await runningServer.stop();
          clearTimeout(forceExitTimer);
          logger.info({ category: 'SERVER_LIFECYCLE' }, 'Graceful shutdown completed');
          process.exit(0);
        } catch {
          clearTimeout(forceExitTimer);
          logger.error(
            { category: 'SERVER_SHUTDOWN_ERROR' },
            'Error during graceful shutdown; exiting with failure'
          );
          process.exit(1);
        }
      };

      process.on('SIGINT', () => gracefulShutdown('SIGINT'));
      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    })
    .catch((err) => {
      // R3-01: Log safe fixed category and allowlisted error code, never raw error messages or secrets
      const rawCode =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code: unknown }).code)
          : undefined;
      const code = rawCode && ALLOWLISTED_ERROR_CODES.has(rawCode) ? rawCode : undefined;

      logger.fatal(
        {
          category: 'FATAL_BOOTSTRAP_ERROR',
          ...(code ? { code } : {}),
        },
        'Fatal bootstrap error occurred'
      );
      process.exit(1);
    });
}
