import { describe, it, expect } from 'vitest';
import { loadEnv, sanitizeUri } from '../src/config/env.js';
import { createLogger, REDACTED_PATHS } from '../src/core/logging.js';

describe('Configuration & Security Guardrails (P1-T10, P1-T11)', () => {
  it('P1-T10: Production environment rejects MOCK_DATABASE=true', () => {
    expect(() => {
      loadEnv({
        NODE_ENV: 'production',
        PORT: 8787,
        WEB_ORIGIN: 'https://app.roundset.com',
        MOCK_DATABASE: 'true',
        MONGODB_URI: 'mongodb+srv://user:pass@cluster0.mongodb.net/prod',
      });
    }).toThrow(/MOCK_DATABASE=true is forbidden in production environment/);
  });

  it('P1-T10: Production environment requires MONGODB_URI', () => {
    expect(() => {
      loadEnv({
        NODE_ENV: 'production',
        PORT: 8787,
        WEB_ORIGIN: 'https://app.roundset.com',
        MOCK_DATABASE: false,
      });
    }).toThrow(/MONGODB_URI is required in production environment/);
  });

  it('Allows offline development with default configuration when MONGODB_URI is omitted', () => {
    const devConfig = loadEnv({
      NODE_ENV: 'development',
    });

    expect(devConfig.NODE_ENV).toBe('development');
    expect(devConfig.PORT).toBe(8787);
    expect(devConfig.WEB_ORIGIN).toBe('http://localhost:5173');
    expect(devConfig.MOCK_DATABASE).toBe(false);
    expect(devConfig.MONGODB_URI).toBeUndefined();
    expect(devConfig.TRUST_PROXY_HOPS).toBe(0);
  });

  it('P1-T11: sanitizeUri redacts user credentials from connection strings', () => {
    const rawUri = 'mongodb+srv://admin_user:SuperSecretPassword123@cluster0.mongodb.net/roundset_db';
    const sanitized = sanitizeUri(rawUri);

    expect(sanitized).toBe('mongodb+srv://***:***@cluster0.mongodb.net/roundset_db');
    expect(sanitized).not.toContain('admin_user');
    expect(sanitized).not.toContain('SuperSecretPassword123');
  });

  it('P1-T11: Logger configuration includes redaction paths for sensitive headers and credentials', () => {
    expect(REDACTED_PATHS).toContain('req.headers.authorization');
    expect(REDACTED_PATHS).toContain('req.headers.cookie');
    expect(REDACTED_PATHS).toContain('req.body');
    expect(REDACTED_PATHS).toContain('*.password');
    expect(REDACTED_PATHS).toContain('*.token');
    expect(REDACTED_PATHS).toContain('*.secret');

    const logger = createLogger();
    expect(logger).toBeDefined();
  });
});
