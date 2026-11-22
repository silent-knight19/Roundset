import mongoose, { Connection } from 'mongoose';
import type { Logger } from 'pino';
import type { ReadinessProvider } from '../core/readiness.js';
import { sanitizeUri } from '../config/env.js';

export class MongoReadinessProvider implements ReadinessProvider {
  public readonly isMock = false;

  constructor(private connection: Connection) {}

  public isReady(): boolean {
    return this.connection.readyState === 1;
  }
}

export class MongoManager {
  private isConnecting = false;

  constructor(private logger?: Logger) {}

  public get connection(): Connection {
    return mongoose.connection;
  }

  public getReadinessProvider(): ReadinessProvider {
    return new MongoReadinessProvider(mongoose.connection);
  }

  public async connect(uri: string): Promise<boolean> {
    if (this.isConnecting || mongoose.connection.readyState === 1) {
      return mongoose.connection.readyState === 1;
    }

    const sanitized = sanitizeUri(uri);
    this.isConnecting = true;

    try {
      this.logger?.info({ uri: sanitized }, 'Connecting to MongoDB...');
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });

      this.logger?.info('MongoDB connected successfully');

      mongoose.connection.on('disconnected', () => {
        this.logger?.warn('MongoDB disconnected; dependency readiness is false');
      });

      mongoose.connection.on('reconnected', () => {
        this.logger?.info('MongoDB reconnected; dependency readiness is true');
      });

      mongoose.connection.on('error', (err) => {
        this.logger?.error({ err }, 'MongoDB connection error');
      });

      this.isConnecting = false;
      return true;
    } catch (err) {
      this.isConnecting = false;
      this.logger?.error(
        { err: err instanceof Error ? err.message : String(err), uri: sanitized },
        'Failed to connect to MongoDB within bounded timeout'
      );
      return false;
    }
  }

  public async disconnect(): Promise<void> {
    if (mongoose.connection.readyState !== 0) {
      try {
        await mongoose.disconnect();
        this.logger?.info('MongoDB disconnected cleanly');
      } catch (err) {
        this.logger?.error({ err }, 'Error during MongoDB disconnect');
      }
    }
  }
}
