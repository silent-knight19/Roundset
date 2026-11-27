import type { ClientSession, Connection } from 'mongoose';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/core/errors.js';
import { runAuthTransaction } from '../src/modules/auth/transaction.js';

function fixture() {
  let active = false;
  const session = {
    startTransaction: vi.fn(() => { active = true; }),
    inTransaction: vi.fn(() => active),
    abortTransaction: vi.fn(async () => { active = false; }),
    commitTransaction: vi.fn(async () => { active = false; }),
    endSession: vi.fn(async () => undefined),
  };
  const connection = {
    readyState: 1,
    startSession: vi.fn(async () => session),
  };
  return {
    session,
    connection,
    conn: connection as unknown as Connection,
    clientSession: session as unknown as ClientSession,
  };
}

function mongoLabel(label: string) {
  return Object.assign(new Error('synthetic private driver detail'), { errorLabels: [label] });
}

describe('P2-AUTH-03b bounded auth transactions', () => {
  it('returns only after majority transaction commit and closes the session', async () => {
    const f = fixture();
    const work = vi.fn(async () => 'committed');
    await expect(runAuthTransaction(f.conn, work)).resolves.toBe('committed');
    expect(work).toHaveBeenCalledExactlyOnceWith(f.clientSession);
    expect(f.session.startTransaction).toHaveBeenCalledWith(expect.objectContaining({
      writeConcern: { w: 'majority' },
      readConcern: { level: 'snapshot' },
    }));
    expect(f.session.commitTransaction).toHaveBeenCalledTimes(1);
    expect(f.session.endSession).toHaveBeenCalledTimes(1);
  });

  it('does not begin commit after the transaction deadline', async () => {
    const f = fixture();
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      await expect(runAuthTransaction(f.conn, async () => {
        now.mockReturnValue(15_001);
        return 'late';
      })).rejects.toMatchObject({ statusCode: 503 });
      expect(f.session.abortTransaction).toHaveBeenCalledOnce();
      expect(f.session.commitTransaction).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
  });

  it('aborts a failed business mutation and never commits it', async () => {
    const f = fixture();
    const failure = new HttpError(400, 'OTP_INVALID', 'Invalid or expired verification code');
    await expect(runAuthTransaction(f.conn, async () => { throw failure; })).rejects.toBe(failure);
    expect(f.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(f.session.commitTransaction).not.toHaveBeenCalled();
    expect(f.session.endSession).toHaveBeenCalledTimes(1);
  });

  it('replays a transient transaction failure on a fresh transaction', async () => {
    const f = fixture();
    const work = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(mongoLabel('TransientTransactionError'))
      .mockResolvedValueOnce('ok');
    await expect(runAuthTransaction(f.conn, work)).resolves.toBe('ok');
    expect(work).toHaveBeenCalledTimes(2);
    expect(f.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(f.session.startTransaction).toHaveBeenCalledTimes(2);
  });

  it('bounds transient retries and sanitizes exhausted failures', async () => {
    const f = fixture();
    const work = vi.fn(async () => { throw mongoLabel('TransientTransactionError'); });
    await expect(runAuthTransaction(f.conn, work)).rejects.toMatchObject({
      statusCode: 503, code: 'SERVICE_UNAVAILABLE',
    });
    expect(work).toHaveBeenCalledTimes(3);
    expect(f.session.abortTransaction).toHaveBeenCalledTimes(3);
  });

  it('retries only commit when a commit acknowledgement is ambiguous', async () => {
    const f = fixture();
    f.session.commitTransaction.mockRejectedValueOnce(mongoLabel('UnknownTransactionCommitResult'));
    const work = vi.fn(async () => 'ok');
    await expect(runAuthTransaction(f.conn, work)).resolves.toBe('ok');
    expect(work).toHaveBeenCalledTimes(1);
    expect(f.session.commitTransaction).toHaveBeenCalledTimes(2);
    expect(f.session.abortTransaction).not.toHaveBeenCalled();
  });

  it('treats an unlabeled client-side commit timeout conservatively as ambiguous', async () => {
    const f = fixture();
    f.session.commitTransaction.mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'MongoOperationTimeoutError' }));
    const work = vi.fn(async () => 'ok');
    await expect(runAuthTransaction(f.conn, work)).resolves.toBe('ok');
    expect(work).toHaveBeenCalledTimes(1);
    expect(f.session.commitTransaction).toHaveBeenCalledTimes(2);
    expect(f.session.abortTransaction).not.toHaveBeenCalled();
  });

  it('never replays work when every commit outcome is ambiguous', async () => {
    const f = fixture();
    f.session.commitTransaction.mockRejectedValue(mongoLabel('UnknownTransactionCommitResult'));
    const work = vi.fn(async () => 'unconfirmed');
    await expect(runAuthTransaction(f.conn, work)).rejects.toMatchObject({
      statusCode: 503, message: 'Transaction outcome is unconfirmed',
    });
    expect(work).toHaveBeenCalledTimes(1);
    expect(f.session.commitTransaction).toHaveBeenCalledTimes(3);
    expect(f.session.abortTransaction).not.toHaveBeenCalled();
    expect(f.session.endSession).toHaveBeenCalledTimes(1);
  });

  it('does not replay when a transient error follows an ambiguous commit', async () => {
    const f = fixture();
    f.session.commitTransaction
      .mockRejectedValueOnce(mongoLabel('UnknownTransactionCommitResult'))
      .mockRejectedValueOnce(mongoLabel('TransientTransactionError'));
    const work = vi.fn(async () => 'unconfirmed');
    await expect(runAuthTransaction(f.conn, work)).rejects.toMatchObject({ statusCode: 503 });
    expect(work).toHaveBeenCalledTimes(1);
    expect(f.session.abortTransaction).not.toHaveBeenCalled();
  });

  it('sanitizes duplicate-key conflicts and does not retry them', async () => {
    const f = fixture();
    const work = vi.fn(async () => {
      throw Object.assign(new Error('private duplicate key value'), { code: 11000 });
    });
    await expect(runAuthTransaction(f.conn, work)).rejects.toMatchObject({
      statusCode: 409, code: 'STATE_CONFLICT', message: 'Concurrent state conflict',
    });
    expect(work).toHaveBeenCalledTimes(1);
    expect(f.session.abortTransaction).toHaveBeenCalledTimes(1);
  });

  it('fails closed without a connected replica-set candidate', async () => {
    const f = fixture();
    f.connection.readyState = 0;
    const work = vi.fn(async () => 'must not run');
    await expect(runAuthTransaction(f.conn, work)).rejects.toMatchObject({ statusCode: 503 });
    expect(f.connection.startSession).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it('does not replay when abort itself fails', async () => {
    const f = fixture();
    f.session.abortTransaction.mockRejectedValueOnce(new Error('abort unavailable'));
    const work = vi.fn(async () => { throw mongoLabel('TransientTransactionError'); });
    await expect(runAuthTransaction(f.conn, work)).rejects.toMatchObject({ statusCode: 503 });
    expect(work).toHaveBeenCalledTimes(1);
    expect(f.session.endSession).toHaveBeenCalledTimes(1);
  });
});
