import { describe, it, expect, vi } from 'vitest';
import { Connection, Types } from 'mongoose';
import {
  EXPECTED_TEST_DB_NAME,
  extractDatabaseName,
  validateIntegrationDatabaseName,
  performHarnessCleanup,
  executeGuaranteedCleanup,
} from './identity-test-harness.js';

describe('Atlas Integration Test Harness Guardrails (P2-AUTH-01)', () => {
  describe('Safety Guardrail 1: Exact Database Name Match', () => {
    it('extracts database name accurately from various URI formats', () => {
      expect(extractDatabaseName('mongodb+srv://user:pass@cluster0.mongodb.net/roundset_test?retryWrites=true')).toBe('roundset_test');
      expect(extractDatabaseName('mongodb://localhost:27017/roundset_test')).toBe('roundset_test');
      expect(extractDatabaseName('mongodb://localhost:27017/roundset_test/')).toBe('roundset_test');
      expect(extractDatabaseName('mongodb+srv://cluster.net/production_db?w=majority')).toBe('production_db');
      expect(extractDatabaseName('mongodb://localhost:27017/')).toBe('');
      expect(extractDatabaseName('mongodb://localhost:27017')).toBe('');
      expect(extractDatabaseName('')).toBe('');
    });

    it('accepts exact match "roundset_test"', () => {
      expect(
        validateIntegrationDatabaseName('mongodb+srv://user:pass@cluster0.mongodb.net/roundset_test?retryWrites=true')
      ).toBe(EXPECTED_TEST_DB_NAME);

      expect(
        validateIntegrationDatabaseName('mongodb://localhost:27017/roundset_test')
      ).toBe(EXPECTED_TEST_DB_NAME);
    });

    it('strictly rejects substring matches containing "test" that are not exact "roundset_test"', () => {
      // Substring matches that previously passed includes('test')
      const invalidTestVariants = [
        'mongodb+srv://user:pass@cluster0.mongodb.net/test?retryWrites=true',
        'mongodb+srv://user:pass@cluster0.mongodb.net/roundset_testing',
        'mongodb+srv://user:pass@cluster0.mongodb.net/my_test_db',
        'mongodb+srv://user:pass@cluster0.mongodb.net/roundset_test_2',
        'mongodb+srv://user:pass@cluster0.mongodb.net/roundset_test_prod',
        'mongodb+srv://user:pass@cluster0.mongodb.net/testing_roundset',
      ];

      for (const uri of invalidTestVariants) {
        expect(() => validateIntegrationDatabaseName(uri)).toThrow(
          /is not authorized for integration tests.*must exactly match "roundset_test"/
        );
      }
    });

    it('strictly rejects production, staging, and empty database names', () => {
      const nonTestUris = [
        'mongodb+srv://user:pass@cluster0.mongodb.net/roundset',
        'mongodb+srv://user:pass@cluster0.mongodb.net/production',
        'mongodb+srv://user:pass@cluster0.mongodb.net/staging',
        'mongodb+srv://user:pass@cluster0.mongodb.net/',
        'mongodb+srv://user:pass@cluster0.mongodb.net',
        '',
      ];

      for (const uri of nonTestUris) {
        expect(() => validateIntegrationDatabaseName(uri)).toThrow(
          /is not authorized for integration tests/
        );
      }
    });
  });

  describe('Safety Guardrail 2: Cleanup Verification & Guaranteed Connection Closure', () => {
    it('successfully cleans up and returns deleted counts when no records remain', async () => {
      const mockUserModel = {
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 2 }),
        countDocuments: vi.fn().mockResolvedValue(0),
      };
      const mockIdentityModel = {
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 2 }),
        countDocuments: vi.fn().mockResolvedValue(0),
      };
      const mockSessionModel = {
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 1 }),
        countDocuments: vi.fn().mockResolvedValue(0),
      };
      const mockChallengeModel = {
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 1 }),
        countDocuments: vi.fn().mockResolvedValue(0),
      };

      const mockConn = {
        models: {
          User: mockUserModel,
          AuthIdentity: mockIdentityModel,
          Session: mockSessionModel,
          VerificationChallenge: mockChallengeModel,
        },
      } as unknown as Connection;

      const dummyUserId = new Types.ObjectId();
      const dummyIdentityId = new Types.ObjectId();

      const result = await performHarnessCleanup(mockConn, {
        createdUserIds: [dummyUserId],
        createdIdentityIds: [dummyIdentityId],
        createdSessionIds: ['sess_1'],
        createdChallengeIds: ['ch_1'],
        runId: 'run_123',
      });

      expect(result.deletedUsers).toBe(2);
      expect(result.deletedIdentities).toBe(2);
      expect(result.deletedSessions).toBe(1);
      expect(result.deletedChallenges).toBe(1);

      expect(mockUserModel.deleteMany).toHaveBeenCalled();
      expect(mockUserModel.countDocuments).toHaveBeenCalled();
    });

    it('fails the suite with descriptive error when synthetic records remain after cleanup', async () => {
      // Simulate deleteMany succeeded but countDocuments detects surviving records
      const mockUserModel = {
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 1 }),
        countDocuments: vi.fn().mockResolvedValue(1), // 1 synthetic user still exists!
      };
      const mockIdentityModel = {
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 1 }),
        countDocuments: vi.fn().mockResolvedValue(0),
      };
      const mockSessionModel = {
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
        countDocuments: vi.fn().mockResolvedValue(0),
      };
      const mockChallengeModel = {
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
        countDocuments: vi.fn().mockResolvedValue(0),
      };

      const mockConn = {
        models: {
          User: mockUserModel,
          AuthIdentity: mockIdentityModel,
          Session: mockSessionModel,
          VerificationChallenge: mockChallengeModel,
        },
      } as unknown as Connection;

      await expect(
        performHarnessCleanup(mockConn, {
          createdUserIds: [new Types.ObjectId()],
          runId: 'surviving_run',
        })
      ).rejects.toThrow(/Cleanup verification failed: Synthetic records still present.*users=1/);
    });

    it('does not swallow deletion errors thrown during cleanup', async () => {
      const mockUserModel = {
        deleteMany: vi.fn().mockRejectedValue(new Error('Atlas network partition during deleteMany')),
        countDocuments: vi.fn().mockResolvedValue(0),
      };
      const mockIdentityModel = {
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
        countDocuments: vi.fn().mockResolvedValue(0),
      };
      const mockSessionModel = {
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
        countDocuments: vi.fn().mockResolvedValue(0),
      };
      const mockChallengeModel = {
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
        countDocuments: vi.fn().mockResolvedValue(0),
      };

      const mockConn = {
        models: {
          User: mockUserModel,
          AuthIdentity: mockIdentityModel,
          Session: mockSessionModel,
          VerificationChallenge: mockChallengeModel,
        },
      } as unknown as Connection;

      await expect(
        performHarnessCleanup(mockConn, {
          createdUserIds: [new Types.ObjectId()],
        })
      ).rejects.toThrow('Atlas network partition during deleteMany');
    });

    it('executeGuaranteedCleanup always closes the connection and rethrows cleanup errors', async () => {
      let closeCalled = false;
      const mockConn = {
        close: vi.fn().mockImplementation(async () => {
          closeCalled = true;
        }),
      } as unknown as Connection;

      const failingCleanup = vi.fn().mockRejectedValue(new Error('Failed to purge synthetic data'));

      // 1. Invariant: Error must be rethrown (not silently swallowed)
      await expect(
        executeGuaranteedCleanup(mockConn, failingCleanup)
      ).rejects.toThrow('Failed to purge synthetic data');

      // 2. Invariant: Connection must always be closed
      expect(closeCalled).toBe(true);
      expect(mockConn.close).toHaveBeenCalledTimes(1);
    });

    it('executeGuaranteedCleanup closes connection on successful cleanup', async () => {
      const mockConn = {
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Connection;

      const successfulCleanup = vi.fn().mockResolvedValue(undefined);

      await expect(
        executeGuaranteedCleanup(mockConn, successfulCleanup)
      ).resolves.toBeUndefined();

      expect(mockConn.close).toHaveBeenCalledTimes(1);
    });
  });
});
