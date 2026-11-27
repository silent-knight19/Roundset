import { describe, it, expect, vi } from 'vitest';
import {
  ARGON2_POLICY,
  BoundedPasswordLimiter,
  PasswordCapacityError,
  PasswordHashPolicyError,
  createPasswordService,
  normalizePasswordForHash,
  normalizePasswordForVerification,
  parseAndValidateArgon2Hash,
  type Argon2Driver,
} from '../src/modules/auth/password/index.js';
import { InvalidInputError } from '../src/core/errors.js';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const VALID_PASSWORD = 'Correct-Horse-Battery-Staple-2026!';

describe('P2-AUTH-03a: Password Security Foundation', () => {
  describe('1-3. Real Argon2id hashing, verification, unique salts, and encoded parameters', () => {
    it('hashes and verifies a valid password and rejects an incorrect password', async () => {
      const service = createPasswordService();
      const hash = await service.hashPassword(VALID_PASSWORD);

      expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(await service.verifyPassword(VALID_PASSWORD, hash)).toBe(true);
      expect(await service.verifyPassword('Wrong-Password-Attempt-2026!', hash)).toBe(false);
    });

    it('produces unique salts and hashes for identical passwords', async () => {
      const service = createPasswordService();
      const hash1 = await service.hashPassword(VALID_PASSWORD);
      const hash2 = await service.hashPassword(VALID_PASSWORD);

      expect(hash1).not.toBe(hash2);
      const salt1 = hash1.split('$')[4];
      const salt2 = hash2.split('$')[4];
      expect(salt1).toBeTruthy();
      expect(salt2).toBeTruthy();
      expect(salt1).not.toBe(salt2);
    });

    it('parses and verifies encoded Argon2id parameters against mandatory policy', async () => {
      const service = createPasswordService();
      const hash = await service.hashPassword(VALID_PASSWORD);
      const parsed = parseAndValidateArgon2Hash(hash);

      expect(parsed.algorithm).toBe(ARGON2_POLICY.algorithm);
      expect(parsed.version).toBe(ARGON2_POLICY.version);
      expect(parsed.memoryCostKiB).toBe(19_456);
      expect(parsed.timeCost).toBe(2);
      expect(parsed.parallelism).toBe(1);
    });
  });

  describe('4-5. Unicode NFC normalization, length boundaries, UTF-8 byte limits, and control chars', () => {
    it('applies Unicode NFC normalization consistently without trimming or truncating', async () => {
      const service = createPasswordService();
      // 'e' + combining acute accent (NFD) vs precomposed 'é' (NFC)
      const nfdPassword = '  passw0rd-' + 'e\u0301' + '-secure!  ';
      const nfcPassword = '  passw0rd-' + '\u00e9' + '-secure!  ';

      const hash = await service.hashPassword(nfdPassword);
      expect(await service.verifyPassword(nfcPassword, hash)).toBe(true);
      // Must NOT silently trim leading/trailing spaces
      expect(await service.verifyPassword(nfcPassword.trim(), hash)).toBe(false);
    });

    it('enforces 12-128 Unicode code points and 512 UTF-8 byte boundaries', () => {
      expect(() => normalizePasswordForHash('a'.repeat(11))).toThrow(InvalidInputError);
      expect(normalizePasswordForHash('a'.repeat(12))).toBe('a'.repeat(12));
      expect(normalizePasswordForHash('a'.repeat(128))).toBe('a'.repeat(128));
      expect(() => normalizePasswordForHash('a'.repeat(129))).toThrow(InvalidInputError);

      // 128 4-byte emoji = 128 code points and exactly 512 UTF-8 bytes -> allowed
      const maxEmoji = '🔐'.repeat(128);
      expect([...maxEmoji].length).toBe(128);
      expect(Buffer.byteLength(maxEmoji, 'utf8')).toBe(512);
      expect(normalizePasswordForHash(maxEmoji)).toBe(maxEmoji);

      // 129 4-byte emoji -> rejected
      expect(() => normalizePasswordForHash('🔐'.repeat(129))).toThrow(InvalidInputError);

      // Verification allows shorter than 12 (legacy/wrong attempts) but enforces <= 512 UTF-8 bytes
      expect(normalizePasswordForVerification('short')).toBe('short');
      expect(() => normalizePasswordForVerification('')).toThrow(InvalidInputError);
      expect(() => normalizePasswordForVerification('🔐'.repeat(129))).toThrow(InvalidInputError);
    });

    it('rejects NUL and prohibited control characters in both hash and verify paths', () => {
      const controlInputs = [
        'valid-pass-\u0000-nul',
        'valid-pass-\n-newline',
        'valid-pass-\r-return',
        'valid-pass-\t-tab',
        'valid-pass-\u007f-del',
      ];

      for (const bad of controlInputs) {
        expect(() => normalizePasswordForHash(bad)).toThrow(InvalidInputError);
        expect(() => normalizePasswordForVerification(bad)).toThrow(InvalidInputError);
      }
    });
  });

  describe('6-7. Malformed hash and oversized cost parameter rejection', () => {
    it('rejects malformed encoded hashes before invoking native verify', async () => {
      const verifySpy = vi.fn(async () => true);
      const driver: Argon2Driver = {
        hash: vi.fn(async () => ''),
        verify: verifySpy,
      };
      const service = createPasswordService({ driver });

      const malformedHashes = [
        '',
        'not-a-phc-hash',
        '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234',
        '$argon2i$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '$argon2id$v=18$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '$argon2id$v=19$m=19456,t=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '$argon2id$v=19$m=19456,t=2,p=1$!!!invalid_b64!!!$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '$argon2id$v=19$m=19456,t=2,p=1$c2hvcnQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$c2hvcnQ',
        '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\u0000',
      ];

      for (const badHash of malformedHashes) {
        await expect(service.verifyPassword(VALID_PASSWORD, badHash)).rejects.toThrow(
          PasswordHashPolicyError
        );
      }
      expect(verifySpy).not.toHaveBeenCalled();
    });

    it('rejects oversized or undersized encoded cost parameters before invoking native verify', async () => {
      const verifySpy = vi.fn(async () => true);
      const driver: Argon2Driver = {
        hash: vi.fn(async () => ''),
        verify: verifySpy,
      };
      const service = createPasswordService({ driver });

      const policyViolatingHashes = [
        // Oversized memory (64 MiB)
        '$argon2id$v=19$m=65536,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        // Oversized time cost
        '$argon2id$v=19$m=19456,t=10,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        // Oversized parallelism
        '$argon2id$v=19$m=19456,t=2,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        // Undersized memory (4 MiB)
        '$argon2id$v=19$m=4096,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        // Undersized time cost
        '$argon2id$v=19$m=19456,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ];

      for (const badCostHash of policyViolatingHashes) {
        await expect(service.verifyPassword(VALID_PASSWORD, badCostHash)).rejects.toThrow(
          PasswordHashPolicyError
        );
      }
      expect(verifySpy).not.toHaveBeenCalled();
    });
  });

  describe('8-11. Bounded concurrency, queue ceiling, queue timeout cleanup, and failure recovery', () => {
    it('enforces max 2 concurrent operations and holds active slots until native work finishes', async () => {
      const limiter = new BoundedPasswordLimiter({
        maxConcurrent: 2,
        maxQueueSize: 8,
        queueTimeoutMs: 3_000,
      });

      const d1 = createDeferred<string>();
      const d2 = createDeferred<string>();
      const d3 = createDeferred<string>();

      let inFlight = 0;
      let maxObserved = 0;

      const p1 = limiter.run(async () => {
        inFlight += 1;
        maxObserved = Math.max(maxObserved, inFlight);
        const res = await d1.promise;
        inFlight -= 1;
        return res;
      });
      const p2 = limiter.run(async () => {
        inFlight += 1;
        maxObserved = Math.max(maxObserved, inFlight);
        const res = await d2.promise;
        inFlight -= 1;
        return res;
      });
      const p3 = limiter.run(async () => {
        inFlight += 1;
        maxObserved = Math.max(maxObserved, inFlight);
        const res = await d3.promise;
        inFlight -= 1;
        return res;
      });

      // Allow microtasks to settle
      await Promise.resolve();
      expect(limiter.getStats()).toMatchObject({ active: 2, queued: 1 });
      expect(maxObserved).toBe(2);

      d1.resolve('one');
      await expect(p1).resolves.toBe('one');
      await Promise.resolve();
      expect(limiter.getStats()).toMatchObject({ active: 2, queued: 0 });

      d2.resolve('two');
      d3.resolve('three');
      await expect(Promise.all([p2, p3])).resolves.toEqual(['two', 'three']);
      expect(limiter.getStats()).toMatchObject({ active: 0, queued: 0 });
    });

    it('enforces max 8 queued operations and rejects the 11th in-flight request immediately', async () => {
      const limiter = new BoundedPasswordLimiter({
        maxConcurrent: 2,
        maxQueueSize: 8,
        queueTimeoutMs: 3_000,
      });

      const deferreds = Array.from({ length: 10 }, () => createDeferred<number>());
      const tasks = deferreds.map((d, idx) => limiter.run(() => d.promise.then(() => idx)));

      await Promise.resolve();
      expect(limiter.getStats()).toMatchObject({ active: 2, queued: 8 });

      // 11th request must be rejected immediately with PasswordCapacityError
      await expect(limiter.run(async () => 999)).rejects.toSatisfy((err: unknown) => {
        return (
          err instanceof PasswordCapacityError &&
          err.statusCode === 503 &&
          err.code === 'CAPACITY_UNAVAILABLE' &&
          err.reason === 'QUEUE_FULL'
        );
      });

      deferreds.forEach((d, idx) => d.resolve(idx));
      await expect(Promise.all(tasks)).resolves.toHaveLength(10);
      expect(limiter.getStats()).toMatchObject({ active: 0, queued: 0 });
    });

    it('times out queued operations cleanly and ensures timed-out operations never start later', async () => {
      vi.useFakeTimers();
      try {
        const limiter = new BoundedPasswordLimiter({
          maxConcurrent: 2,
          maxQueueSize: 8,
          queueTimeoutMs: 3_000,
        });

        const d1 = createDeferred<void>();
        const d2 = createDeferred<void>();
        const timedOutSpy = vi.fn(async () => 'should-never-run');

        const p1 = limiter.run(() => d1.promise);
        const p2 = limiter.run(() => d2.promise);
        const pQueued = limiter.run(timedOutSpy);

        expect(limiter.getStats()).toMatchObject({ active: 2, queued: 1 });

        vi.advanceTimersByTime(3_000);
        await expect(pQueued).rejects.toSatisfy((err: unknown) => {
          return (
            err instanceof PasswordCapacityError &&
            err.statusCode === 503 &&
            err.code === 'CAPACITY_UNAVAILABLE' &&
            err.reason === 'QUEUE_TIMEOUT'
          );
        });

        expect(limiter.getStats()).toMatchObject({ active: 2, queued: 0 });

        d1.resolve();
        d2.resolve();
        await Promise.all([p1, p2]);
        await Promise.resolve();

        expect(timedOutSpy).not.toHaveBeenCalled();
        expect(limiter.getStats()).toMatchObject({ active: 0, queued: 0 });
      } finally {
        vi.useRealTimers();
      }
    });

    it('releases capacity and recovers after a hashing or verification failure', async () => {
      let shouldFail = true;
      const driver: Argon2Driver = {
        hash: vi.fn(async () => {
          if (shouldFail) {
            throw new Error('simulated native failure');
          }
          return '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        }),
        verify: vi.fn(async () => true),
      };

      const service = createPasswordService({ driver });
      await expect(service.hashPassword(VALID_PASSWORD)).rejects.toMatchObject({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
      });
      expect(service.getLimiterStats()).toMatchObject({ active: 0, queued: 0 });

      shouldFail = false;
      const hash = await service.hashPassword(VALID_PASSWORD);
      expect(hash).toContain('$argon2id$');
      expect(service.getLimiterStats()).toMatchObject({ active: 0, queued: 0 });
    });
  });

  describe('12. Dummy verification behavior', () => {
    it('always returns false, initializes dummy hash once, and shares the capacity limiter', async () => {
      const hashSpy = vi.fn(
        async () =>
          '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      );
      const verifySpy = vi.fn(async () => true);

      const service = createPasswordService({
        driver: { hash: hashSpy, verify: verifySpy },
      });

      const res1 = await service.verifyDummy('unknown-user-password-1');
      const res2 = await service.verifyDummy('unknown-user-password-2');
      const res3 = await service.verifyDummy('unknown-user-password-3');

      expect(res1).toBe(false);
      expect(res2).toBe(false);
      expect(res3).toBe(false);
      // Dummy hash generated only once, not per unknown-account attempt
      expect(hashSpy).toHaveBeenCalledTimes(1);
      expect(verifySpy).toHaveBeenCalledTimes(3);
      expect(service.getLimiterStats()).toMatchObject({ active: 0, queued: 0 });
    });
  });

  describe('13. Secret and error-message sanitization', () => {
    it('never leaks raw passwords or encoded hashes in thrown errors', async () => {
      const secretPassword = 'SuperSecretPassword!2026\u0000';
      const secretHash =
        '$argon2id$v=19$m=65536,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$SecretDigestValueThatMustNotLeakAAAAAAAAAAAA';

      const service = createPasswordService({
        driver: {
          hash: async () => {
            throw new Error(`driver exploded with ${secretPassword}`);
          },
          verify: async () => {
            throw new Error(`driver exploded with ${secretHash}`);
          },
        },
      });

      try {
        normalizePasswordForHash(secretPassword);
        expect.fail('Expected InvalidInputError');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toContain('SuperSecretPassword');
      }

      try {
        await service.verifyPassword(VALID_PASSWORD, secretHash);
        expect.fail('Expected PasswordHashPolicyError');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toContain(secretHash);
        expect(msg).not.toContain('SecretDigestValue');
      }

      try {
        await service.hashPassword(VALID_PASSWORD);
        expect.fail('Expected sanitized HttpError');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toContain('SuperSecretPassword');
        expect(msg).toBe('Password hashing failed');
      }
    });
  });
});
