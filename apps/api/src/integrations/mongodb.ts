import mongoose, { Connection } from 'mongoose';
import type { Logger } from 'pino';
import type { ReadinessProvider } from '../core/readiness.js';

export class MongoReadinessProvider implements ReadinessProvider {
  public readonly isMock = false;

  constructor(private connection: Connection) {}

  public isReady(): boolean {
    return this.connection.readyState === 1;
  }
}

export class MongoManager {
  private isConnecting = false;
  private listenersAttached = false;
  private readonly onDisconnectedHandler: () => void;
  private readonly onReconnectedHandler: () => void;
  private readonly onErrorHandler: () => void;

  constructor(private logger?: Logger) {
    this.onDisconnectedHandler = () => {
      this.logger?.warn(
        { state: 'disconnected', category: 'DATABASE_LIFECYCLE' },
        'Database disconnected; dependency readiness is false'
      );
    };

    this.onReconnectedHandler = () => {
      this.logger?.info(
        { state: 'reconnected', category: 'DATABASE_LIFECYCLE' },
        'Database reconnected; dependency readiness is true'
      );
    };

    this.onErrorHandler = () => {
      this.logger?.error(
        { state: 'error', category: 'DATABASE_RUNTIME_ERROR' },
        'Database runtime error occurred'
      );
    };

    this.attachConnectionListeners();
  }

  public get connection(): Connection {
    return mongoose.connection;
  }

  public getReadinessProvider(): ReadinessProvider {
    return new MongoReadinessProvider(mongoose.connection);
  }

  public attachConnectionListeners(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    mongoose.connection.on('disconnected', this.onDisconnectedHandler);
    mongoose.connection.on('reconnected', this.onReconnectedHandler);
    mongoose.connection.on('error', this.onErrorHandler);
  }

  public removeConnectionListeners(): void {
    if (!this.listenersAttached) return;
    this.listenersAttached = false;

    mongoose.connection.removeListener('disconnected', this.onDisconnectedHandler);
    mongoose.connection.removeListener('reconnected', this.onReconnectedHandler);
    mongoose.connection.removeListener('error', this.onErrorHandler);
  }

  public async connect(uri: string): Promise<boolean> {
    if (this.isConnecting || mongoose.connection.readyState === 1) {
      return mongoose.connection.readyState === 1;
    }

    this.isConnecting = true;

    try {
      this.logger?.info(
        { state: 'connecting', category: 'DATABASE_LIFECYCLE' },
        'Database connection attempt initiated'
      );

      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        // Driver-enforced operation/socket deadlines; no detached Promise.race writes.
        socketTimeoutMS: 5000,
        waitQueueTimeoutMS: 5000,
      });

      this.logger?.info(
        { state: 'connected', category: 'DATABASE_LIFECYCLE' },
        'Database connection established'
      );

      this.isConnecting = false;
      return true;
    } catch {
      this.isConnecting = false;
      this.logger?.error(
        { state: 'failed', category: 'DATABASE_CONNECTION_TIMEOUT' },
        'Database connection attempt failed within bounded timeout'
      );
      return false;
    }
  }

  public async disconnect(): Promise<void> {
    this.isConnecting = false;
    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
        this.logger?.info(
          { state: 'disconnected', category: 'DATABASE_LIFECYCLE' },
          'Database disconnected cleanly'
        );
      }
    } catch {
      this.logger?.error(
        { state: 'disconnect_error', category: 'DATABASE_DISCONNECT_ERROR' },
        'Error during database disconnect'
      );
    } finally {
      this.removeConnectionListeners();
    }
  }
}
