import type { ClientSession, Connection } from 'mongoose';
import { performance } from 'node:perf_hooks';
import { HttpError, ServiceUnavailableError } from '../../core/errors.js';

const MAX_TRANSACTION_ATTEMPTS = 3;
const MAX_COMMIT_ATTEMPTS = 3;
const TRANSACTION_DEADLINE_MS = 15_000;

function hasLabel(error: unknown, label: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    hasErrorLabel?: (value: string) => boolean;
    errorLabels?: unknown;
  };
  return (
    (typeof candidate.hasErrorLabel === 'function' && candidate.hasErrorLabel(label)) ||
    (Array.isArray(candidate.errorLabels) && candidate.errorLabels.includes(label))
  );
}

async function abortIfActive(session: ClientSession): Promise<boolean> {
  try {
    if (session.inTransaction()) await session.abortTransaction();
    return true;
  } catch {
    return false;
  }
}

/**
 * Run deterministic database-only authentication work on one ClientSession.
 * A transient transaction failure may replay the callback; an ambiguous commit
 * may retry ONLY commit on the same transaction. Never return success when
 * the commit outcome is unconfirmed, or retry the callback after ambiguity.
 * Callers must perform Argon2, provider calls and HTTP responses outside work.
 */
export async function runAuthTransaction<T>(
  connection: Connection,
  work: (session: ClientSession) => Promise<T>
): Promise<T> {
  if (connection.readyState !== 1) {
    throw new ServiceUnavailableError('Database transactions are unavailable');
  }

  const deadline = performance.now() + TRANSACTION_DEADLINE_MS;
  function checkDeadline(): void {
    if (performance.now() >= deadline) throw new ServiceUnavailableError('Authentication transaction deadline exceeded');
  }
  let session: ClientSession;
  try {
    session = await connection.startSession();
  } catch {
    throw new ServiceUnavailableError('Database transactions are unavailable');
  }

  try {
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      let commitAmbiguous = false;
      try {
        checkDeadline();
        session.startTransaction({
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
          maxCommitTimeMS: 5000,
        });
        const result = await work(session);

        for (let commitAttempt = 0; commitAttempt < MAX_COMMIT_ATTEMPTS; commitAttempt += 1) {
          try {
            checkDeadline();
            await session.commitTransaction();
            return result;
          } catch (error) {
            if (hasLabel(error, 'UnknownTransactionCommitResult')) {
              commitAmbiguous = true;
              continue;
            }
            throw error;
          }
        }
        throw new ServiceUnavailableError('Transaction outcome is unconfirmed');
      } catch (error) {
        // Once a commit has been ambiguous, do not replay or explicitly abort
        // the transaction, even if a later commit retry returns another error.
        if (commitAmbiguous) {
          throw new ServiceUnavailableError('Transaction outcome is unconfirmed');
        }

        const aborted = await abortIfActive(session);
        if (error instanceof HttpError) throw error;
        if (!aborted) {
          throw new ServiceUnavailableError('Database transactions are unavailable');
        }
        if (
          hasLabel(error, 'TransientTransactionError') &&
          attempt + 1 < MAX_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
          throw new HttpError(409, 'STATE_CONFLICT', 'Concurrent state conflict');
        }
        throw new ServiceUnavailableError('Database transactions are unavailable');
      }
    }
    throw new ServiceUnavailableError('Database transactions are unavailable');
  } finally {
    try {
      await session.endSession();
    } catch {
      // Cleanup failure cannot change an already confirmed durable outcome.
    }
  }
}
