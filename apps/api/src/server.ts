import type { Server } from 'node:http';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createLogger } from './core/logging.js';
import { MongoManager } from './integrations/mongodb.js';
import { MockReadinessProvider, type ReadinessProvider } from './core/readiness.js';

const logger = createLogger();

async function bootstrap(): Promise<void> {
  const config = loadEnv();

  let mongoManager: MongoManager | null = null;
  let readinessProvider: ReadinessProvider;

  if (config.MOCK_DATABASE) {
    logger.warn('[DEVELOPMENT MOCK] MOCK_DATABASE=true is active. Mock readiness enabled.');
    readinessProvider = new MockReadinessProvider(true);
  } else if (config.MONGODB_URI) {
    mongoManager = new MongoManager(logger);
    readinessProvider = mongoManager.getReadinessProvider();
    const connected = await mongoManager.connect(config.MONGODB_URI);
    if (!connected) {
      logger.warn('Initial MongoDB connection was unsuccessful; continuing with readiness=false');
    }
  } else {
    logger.warn('MONGODB_URI is not set; running in offline development mode (readiness=false)');
    readinessProvider = new MockReadinessProvider(false);
  }

  const app = createApp({
    env: config,
    logger,
    readinessProvider,
  });

  const server: Server = app.listen(config.PORT, () => {
    logger.info(
      {
        port: config.PORT,
        nodeEnv: config.NODE_ENV,
        webOrigin: config.WEB_ORIGIN,
        mockDatabase: config.MOCK_DATABASE,
      },
      `API service listening on port ${config.PORT}`
    );
  });

  // Graceful shutdown handling
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Received termination signal, initiating graceful shutdown...');

    server.close(async () => {
      logger.info('HTTP server closed; disconnecting dependencies');
      if (mongoManager) {
        await mongoManager.disconnect();
      }
      logger.info('Graceful shutdown completed');
      process.exit(0);
    });

    // Force exit after 10s if shutdown hangs
    setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'Fatal bootstrap error');
  process.exit(1);
});
