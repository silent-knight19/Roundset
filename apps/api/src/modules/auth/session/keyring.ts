import crypto from 'node:crypto';
import * as jose from 'jose';
import type { AppConfig } from '../../../config/env.js';

export class SessionKeyring {
  public readonly jwtIssuer: string;
  public readonly jwtAudience: string;
  private activeJwtKid: string;
  private jwtSigningKey!: jose.CryptoKey;
  private jwtVerificationKeys = new Map<string, jose.CryptoKey>();

  private activeRefreshKid: string;
  private refreshHmacKeys = new Map<string, Buffer>();
  private refreshDigestKeys = new Map<string, Buffer>();

  private activeCsrfKid: string;
  private csrfHmacKeys = new Map<string, Buffer>();

  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly config: AppConfig) {
    this.jwtIssuer = config.JWT_ISSUER;
    this.jwtAudience = config.JWT_AUDIENCE;
    this.activeJwtKid = config.JWT_ACTIVE_KID;
    this.activeRefreshKid = config.REFRESH_ACTIVE_KID;
    this.activeCsrfKid = config.CSRF_ACTIVE_KID;
  }

  public async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    await this.initPromise;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    // 1. JWT Key Initialization
    let privPem = this.config.JWT_PRIVATE_KEY_PEM;
    let pubPem = this.config.JWT_PUBLIC_KEY_PEM;

    if (!privPem || !pubPem) {
      if (this.config.NODE_ENV === 'production') {
        throw new Error('JWT keys cannot be automatically generated in production');
      }
      // Generate in-memory fallback keypair for dev / test
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
      privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    }

    this.jwtSigningKey = await jose.importPKCS8(privPem, 'EdDSA');
    const pubKey = await jose.importSPKI(pubPem, 'EdDSA');
    this.jwtVerificationKeys.set(this.activeJwtKid, pubKey);

    // 2. Refresh HMAC & Digest Keys Initialization
    const defaultRefreshSecret =
      this.config.REFRESH_HMAC_KEY ||
      (this.config.NODE_ENV !== 'production'
        ? 'dev-refresh-hmac-secret-min-32-chars-long!!'
        : '');
    const defaultDigestSecret =
      this.config.REFRESH_DIGEST_KEY ||
      (this.config.NODE_ENV !== 'production'
        ? 'dev-refresh-digest-secret-min-32-chars-long!'
        : '');

    if (!defaultRefreshSecret || !defaultDigestSecret) {
      throw new Error('Refresh HMAC and Digest secrets must be configured');
    }

    this.refreshHmacKeys.set(this.activeRefreshKid, Buffer.from(defaultRefreshSecret, 'utf-8'));
    this.refreshDigestKeys.set(this.activeRefreshKid, Buffer.from(defaultDigestSecret, 'utf-8'));

    // 3. CSRF HMAC Key Initialization
    const defaultCsrfSecret =
      this.config.CSRF_HMAC_KEY ||
      (this.config.NODE_ENV !== 'production'
        ? 'dev-csrf-hmac-secret-min-32-chars-long-secure!'
        : '');

    if (!defaultCsrfSecret) {
      throw new Error('CSRF HMAC secret must be configured');
    }

    this.csrfHmacKeys.set(this.activeCsrfKid, Buffer.from(defaultCsrfSecret, 'utf-8'));

    this.initialized = true;
  }

  // JWT methods
  public getActiveJwtKid(): string {
    return this.activeJwtKid;
  }

  public getJwtSigningKey(): { kid: string; key: jose.CryptoKey } {
    if (!this.initialized) {
      throw new Error('SessionKeyring must be initialized before use');
    }
    return { kid: this.activeJwtKid, key: this.jwtSigningKey };
  }

  public getJwtVerificationKey(kid: string): jose.CryptoKey | null {
    if (!this.initialized) {
      throw new Error('SessionKeyring must be initialized before use');
    }
    return this.jwtVerificationKeys.get(kid) ?? null;
  }

  public async registerRetiredJwtKey(kid: string, publicKeyPem: string): Promise<void> {
    const pubKey = await jose.importSPKI(publicKeyPem, 'EdDSA');
    this.jwtVerificationKeys.set(kid, pubKey);
  }

  public async rotateJwtSigningKey(newKid: string, privateKeyPem: string, publicKeyPem: string): Promise<void> {
    const privKey = await jose.importPKCS8(privateKeyPem, 'EdDSA');
    const pubKey = await jose.importSPKI(publicKeyPem, 'EdDSA');
    this.jwtSigningKey = privKey;
    this.activeJwtKid = newKid;
    this.jwtVerificationKeys.set(newKid, pubKey);
  }

  // Refresh methods
  public getActiveRefreshKid(): string {
    return this.activeRefreshKid;
  }

  public getRefreshHmacKey(kid: string): Buffer | null {
    if (!this.initialized) {
      throw new Error('SessionKeyring must be initialized before use');
    }
    return this.refreshHmacKeys.get(kid) ?? null;
  }

  public getRefreshDigestKey(kid: string): Buffer | null {
    if (!this.initialized) {
      throw new Error('SessionKeyring must be initialized before use');
    }
    return this.refreshDigestKeys.get(kid) ?? null;
  }

  public registerRetiredRefreshKeys(kid: string, hmacSecret: string, digestSecret: string): void {
    this.refreshHmacKeys.set(kid, Buffer.from(hmacSecret, 'utf-8'));
    this.refreshDigestKeys.set(kid, Buffer.from(digestSecret, 'utf-8'));
  }

  public rotateRefreshKeys(newKid: string, hmacSecret: string, digestSecret: string): void {
    this.activeRefreshKid = newKid;
    this.registerRetiredRefreshKeys(newKid, hmacSecret, digestSecret);
  }

  // CSRF methods
  public getActiveCsrfKid(): string {
    return this.activeCsrfKid;
  }

  public getCsrfHmacKey(kid: string): Buffer | null {
    if (!this.initialized) {
      throw new Error('SessionKeyring must be initialized before use');
    }
    return this.csrfHmacKeys.get(kid) ?? null;
  }

  public registerRetiredCsrfKey(kid: string, hmacSecret: string): void {
    this.csrfHmacKeys.set(kid, Buffer.from(hmacSecret, 'utf-8'));
  }

  public rotateCsrfKey(newKid: string, hmacSecret: string): void {
    this.activeCsrfKid = newKid;
    this.registerRetiredCsrfKey(newKid, hmacSecret);
  }
}
