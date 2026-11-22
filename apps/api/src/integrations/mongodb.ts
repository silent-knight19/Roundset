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

  constructor(private logger?: Logger) {
    this.attachConnectionListeners();
  }

  public get connection(): Connection {
    return mongoose.connection;
  }

  public getReadinessProvider(): ReadinessProvider {
    return new MongoReadinessProvider(mongoose.connection);
  }

  private attachConnectionListeners(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    mongoose.connection.on('disconnected', () => {
      this.logger?.warn(
        { state: 'disconnected', category: 'DATABASE_LIFECYCLE' },
        'Database disconnected; dependency readiness is false'
      );
    });

    mongoose.connection.on('reconnected', () => {
      this.logger?.info(
        { state: 'reconnected', category: 'DATABASE_LIFECYCLE' },
        'Database reconnected; dependency readiness is true'
      );
    });

    mongoose.connection.on('error', () => {
      this.logger?.error(
        { state: 'error', category: 'DATABASE_RUNTIME_ERROR' },
        'Database runtime error occurred'
      );
    });
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
    if (mongoose.connection.readyState !== 0) {
      try {
        await mongoose.disconnect();
        this.logger?.info(
          { state: 'disconnected', category: 'DATABASE_LIFECYCLE' },
          'Database disconnected cleanly'
        );
      } catch {
        this.logger?.error(
          { state: 'disconnect_error', category: 'DATABASE_DISCONNECT_ERROR' },
          'Error during database disconnect'
        );
      }
    }
  }
}
