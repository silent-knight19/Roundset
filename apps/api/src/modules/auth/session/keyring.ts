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

    // R4: Validate active JWT signing key and public-key pairing cryptographically
    try {
      const probePayload = { probe: true };
      const probeJwt = await new jose.SignJWT(probePayload)
        .setProtectedHeader({ alg: 'EdDSA', kid: this.activeJwtKid })
        .sign(this.jwtSigningKey);
      await jose.jwtVerify(probeJwt, pubKey, { algorithms: ['EdDSA'] });
    } catch {
      throw new Error('Active JWT private key and public key do not form a valid cryptographic pair');
    }

    this.jwtVerificationKeys.set(this.activeJwtKid, pubKey);

    // R4 / R2-01: Restore explicitly configured retired JWT verification keys across restart
    if (this.config.JWT_RETIRED_KEYS_JSON) {
      for (const item of this.config.JWT_RETIRED_KEYS_JSON) {
        if (item.kid === this.activeJwtKid) {
          throw new Error(`Retired JWT key ID "${item.kid}" collides with active key ID`);
        }
        if (this.jwtVerificationKeys.has(item.kid)) {
          throw new Error(`Duplicate or conflicting JWT key ID "${item.kid}"`);
        }
        await this.registerRetiredJwtKey(item.kid, item.publicKeyPem);
      }
    }

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

    const refreshHmacBuf = Buffer.from(defaultRefreshSecret, 'utf-8');
    const refreshDigestBuf = Buffer.from(defaultDigestSecret, 'utf-8');

    // R4: Enforce independent refresh integrity and digest key material
    if (refreshHmacBuf.equals(refreshDigestBuf)) {
      throw new Error('Refresh HMAC integrity key and digest key must be distinct');
    }

    this.refreshHmacKeys.set(this.activeRefreshKid, refreshHmacBuf);
    this.refreshDigestKeys.set(this.activeRefreshKid, refreshDigestBuf);

    // R4 / R2-01: Restore explicitly configured retired refresh keys across restart
    if (this.config.REFRESH_RETIRED_KEYS_JSON) {
      for (const item of this.config.REFRESH_RETIRED_KEYS_JSON) {
        if (item.kid === this.activeRefreshKid) {
          throw new Error(`Retired refresh key ID "${item.kid}" collides with active key ID`);
        }
        if (this.refreshHmacKeys.has(item.kid) || this.refreshDigestKeys.has(item.kid)) {
          throw new Error(`Duplicate or conflicting refresh key ID "${item.kid}"`);
        }
        this.registerRetiredRefreshKeys(item.kid, item.hmacSecret, item.digestSecret);
      }
    }

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

    // R4 / R2-01: Restore explicitly configured retired CSRF keys across restart
    if (this.config.CSRF_RETIRED_KEYS_JSON) {
      for (const item of this.config.CSRF_RETIRED_KEYS_JSON) {
        if (item.kid === this.activeCsrfKid) {
          throw new Error(`Retired CSRF key ID "${item.kid}" collides with active key ID`);
        }
        if (this.csrfHmacKeys.has(item.kid)) {
          throw new Error(`Duplicate or conflicting CSRF key ID "${item.kid}"`);
        }
        this.registerRetiredCsrfKey(item.kid, item.hmacSecret);
      }
    }

    // R2-01: Verify the active signing/verification pair still functions after all retired keys load
    try {
      const postInitProbe = await new jose.SignJWT({ postInitTest: true })
        .setProtectedHeader({ alg: 'EdDSA', kid: this.activeJwtKid })
        .sign(this.jwtSigningKey);
      const activePub = this.jwtVerificationKeys.get(this.activeJwtKid);
      if (!activePub) {
        throw new Error('Active JWT verification key missing from keyring');
      }
      await jose.jwtVerify(postInitProbe, activePub, { algorithms: ['EdDSA'] });
    } catch (err) {
      throw new Error(
        `Active JWT keypair failed post-initialization validation: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

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
    if (kid === this.activeJwtKid) {
      throw new Error(`Cannot register retired JWT key with active key ID "${kid}"`);
    }
    if (this.jwtVerificationKeys.has(kid)) {
      throw new Error(`JWT key ID "${kid}" is already registered`);
    }
    const pubKey = await jose.importSPKI(publicKeyPem, 'EdDSA');
    this.jwtVerificationKeys.set(kid, pubKey);
  }

  public async rotateJwtSigningKey(
    newKid: string,
    privateKeyPem: string,
    publicKeyPem: string
  ): Promise<void> {
    if (newKid === this.activeJwtKid) {
      throw new Error(`Cannot rotate to existing active JWT key ID "${newKid}"`);
    }
    if (this.jwtVerificationKeys.has(newKid)) {
      throw new Error(`JWT key ID "${newKid}" already exists in keyring`);
    }
    const privKey = await jose.importPKCS8(privateKeyPem, 'EdDSA');
    const pubKey = await jose.importSPKI(publicKeyPem, 'EdDSA');

    try {
      const probe = await new jose.SignJWT({ rotateTest: true })
        .setProtectedHeader({ alg: 'EdDSA', kid: newKid })
        .sign(privKey);
      await jose.jwtVerify(probe, pubKey, { algorithms: ['EdDSA'] });
    } catch {
      throw new Error(`New JWT key ID "${newKid}" private and public keys do not form a valid cryptographic pair`);
    }

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
    if (kid === this.activeRefreshKid) {
      throw new Error(`Cannot register retired refresh key with active key ID "${kid}"`);
    }
    if (this.refreshHmacKeys.has(kid) || this.refreshDigestKeys.has(kid)) {
      throw new Error(`Refresh key ID "${kid}" is already registered`);
    }
    const hmacBuf = Buffer.from(hmacSecret, 'utf-8');
    const digestBuf = Buffer.from(digestSecret, 'utf-8');
    if (hmacBuf.equals(digestBuf)) {
      throw new Error('Refresh HMAC integrity key and digest key must be distinct');
    }
    this.refreshHmacKeys.set(kid, hmacBuf);
    this.refreshDigestKeys.set(kid, digestBuf);
  }

  public rotateRefreshKeys(newKid: string, hmacSecret: string, digestSecret: string): void {
    if (newKid === this.activeRefreshKid) {
      throw new Error(`Cannot rotate to existing active refresh key ID "${newKid}"`);
    }
    if (this.refreshHmacKeys.has(newKid) || this.refreshDigestKeys.has(newKid)) {
      throw new Error(`Refresh key ID "${newKid}" already exists in keyring`);
    }
    const hmacBuf = Buffer.from(hmacSecret, 'utf-8');
    const digestBuf = Buffer.from(digestSecret, 'utf-8');
    if (hmacBuf.equals(digestBuf)) {
      throw new Error('Refresh HMAC integrity key and digest key must be distinct');
    }
    this.activeRefreshKid = newKid;
    this.refreshHmacKeys.set(newKid, hmacBuf);
    this.refreshDigestKeys.set(newKid, digestBuf);
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
    if (kid === this.activeCsrfKid) {
      throw new Error(`Cannot register retired CSRF key with active key ID "${kid}"`);
    }
    if (this.csrfHmacKeys.has(kid)) {
      throw new Error(`CSRF key ID "${kid}" is already registered`);
    }
    this.csrfHmacKeys.set(kid, Buffer.from(hmacSecret, 'utf-8'));
  }

  public rotateCsrfKey(newKid: string, hmacSecret: string): void {
    if (newKid === this.activeCsrfKid) {
      throw new Error(`Cannot rotate to existing active CSRF key ID "${newKid}"`);
    }
    if (this.csrfHmacKeys.has(newKid)) {
      throw new Error(`CSRF key ID "${newKid}" already exists in keyring`);
    }
    this.activeCsrfKid = newKid;
    this.csrfHmacKeys.set(newKid, Buffer.from(hmacSecret, 'utf-8'));
  }
}
