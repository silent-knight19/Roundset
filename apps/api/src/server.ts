import type { Server } from 'node:http';
import type { Logger } from 'pino';
import { createApp } from './app.js';
import { loadEnv, type AppConfig } from './config/env.js';
import { createLogger } from './core/logging.js';
import { MongoManager } from './integrations/mongodb.js';
import { MockReadinessProvider, type ReadinessProvider } from './core/readiness.js';

export interface StartServerOptions {
  env?: AppConfig;
  logger?: Logger;
  mongoManager?: {
    connect(uri: string): Promise<boolean>;
    disconnect(): Promise<void>;
    getReadinessProvider(): ReadinessProvider;
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
 * Boots the HTTP application server following the mandated startup sequence:
 * 1. Load and validate configuration.
 * 2. Create the readiness provider, initially unready in real database mode.
 * 3. Create the Express application.
 * 4. Start the HTTP listener.
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

  // 3. Create the Express application
  const app = createApp({
    env: config,
    logger,
    readinessProvider,
  });

  const listenPort = options.port ?? config.PORT;

  // 4. Start HTTP listener
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(listenPort, () => {
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
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : listenPort;

  // 5. Initiate bounded MongoDB connection attempt without blocking HTTP startup
  // 6. Readiness is set to true only when Mongoose reports a connected state
  // 7. Liveness remains available if the connection fails
  if (mongoManager && config.MONGODB_URI) {
    mongoManager.connect(config.MONGODB_URI).catch(() => {
      // Handled internally in mongoManager without throwing
    });
  }

  const stop = async (): Promise<void> => {
    return new Promise<void>((resolve) => {
      server.close(async () => {
        logger.info({ category: 'SERVER_LIFECYCLE' }, 'HTTP server closed; disconnecting dependencies');
        if (mongoManager) {
          try {
            await mongoManager.disconnect();
          } catch {
            // Handled internally
          }
        }
        resolve();
      });
    });
  };

  return {
    server,
    port: actualPort,
    readinessProvider,
    stop,
  };
}

// Auto-start when executed directly as entrypoint
const isDirectEntry = !process.env.VITEST && !process.env.NODE_TEST_CONTEXT;
if (isDirectEntry) {
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
        await runningServer.stop();
        logger.info({ category: 'SERVER_LIFECYCLE' }, 'Graceful shutdown completed');
        process.exit(0);
      };

      process.on('SIGINT', () => gracefulShutdown('SIGINT'));
      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    })
    .catch((err) => {
      logger.fatal(
        {
          category: 'FATAL_BOOTSTRAP_ERROR',
          errorMessage: err instanceof Error ? err.message : 'Unknown bootstrap error',
        },
        'Fatal bootstrap error'
      );
      process.exit(1);
    });
}
