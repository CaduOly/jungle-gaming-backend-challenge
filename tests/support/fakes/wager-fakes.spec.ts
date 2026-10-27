import { beforeEach, describe, expect, it } from 'bun:test';
import { FailureCode } from '../../../src/business/shared/error/failure-code';
import { UniqueConstraintViolationError } from '../../../src/business/shared/error/unique-constraint-violation-error';
import { WagerTransaction } from '../../../src/business/wagering/entity/wager-transaction';
import { WagerKind } from '../../../src/business/wagering/enum/wager-kind';
import { aProcessedWager, aWager, brl, T0 } from '../builders/wager-transaction.builder';
import { FakePayloadHasher } from './fake-payload-hasher';
import {
  InMemoryWagerTransactionRepository,
  InMemoryWagerTransactionStore,
} from './in-memory-wager-transaction-repository';

const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

const pending = (ext: string, nextAttemptSeconds: number): WagerTransaction => {
  const transaction = aWager(WagerKind.ROLLBACK, ext, { referenceExternalTransactionId: `missing-${ext}` });
  transaction.markPendingReference(at(nextAttemptSeconds));
  return transaction;
};

describe('InMemoryWagerTransactionRepository', () => {
  let store: InMemoryWagerTransactionStore;
  let repository: InMemoryWagerTransactionRepository;

  beforeEach(() => {
    store = new InMemoryWagerTransactionStore();
    repository = new InMemoryWagerTransactionRepository(store);
  });

  it('finds by id, idempotency key and external id, scoped by provider, returning copies', async () => {
    const bet = aProcessedWager(WagerKind.BET, 'bet');
    await repository.insert(bet);
    expect((await repository.findById(bet.id))?.toState()).toEqual(bet.toState());
    expect((await repository.findByIdempotencyKey('provider-1', 'key-bet'))?.id).toBe(bet.id);
    expect((await repository.findByExternalId('provider-1', 'bet'))?.id).toBe(bet.id);
    expect(await repository.findByIdempotencyKey('provider-2', 'key-bet')).toBeNull();
    expect(await repository.findByExternalId('provider-2', 'bet')).toBeNull();
    expect(await repository.findById(bet.id)).not.toBe(await repository.findById(bet.id));
  });

  it.each([
    [{ idempotencyKey: 'key-bet' }, 'UNIQUE(provider_id, idempotency_key)'],
    [{ externalTransactionId: 'bet' }, 'UNIQUE(provider_id, external_transaction_id)'],
  ])('enforces %p', async (overrides, constraint) => {
    await repository.insert(aProcessedWager(WagerKind.BET, 'bet'));
    const twin = aProcessedWager(WagerKind.BET, 'other', { id: 'id-other', ...overrides });
    await expect(repository.insert(twin)).rejects.toThrow(constraint);
    await repository.insert(aProcessedWager(WagerKind.BET, 'bet', { id: 'p2', providerId: 'provider-2' }));
  });

  it('never persists PENDING and never inserts the same id twice', async () => {
    await expect(repository.insert(aWager(WagerKind.BET, 'bet'))).rejects.toThrow('never persisted');
    await repository.insert(aProcessedWager(WagerKind.BET, 'bet'));
    await expect(repository.insert(aProcessedWager(WagerKind.BET, 'bet'))).rejects.toThrow('PRIMARY KEY');
  });

  it('allows one processed reversal per reference and reports it through isReversed', async () => {
    const bet = aProcessedWager(WagerKind.BET, 'bet');
    await repository.insert(bet);
    expect(await repository.isReversed(bet.id)).toBe(false);

    const rejected = aWager(WagerKind.REFUND, 'refund-0', { referenceExternalTransactionId: 'bet' });
    rejected.attachReference(bet);
    rejected.reject(FailureCode.AMOUNT_MISMATCH, brl('1.00'), T0);
    await repository.insert(rejected);
    expect(await repository.isReversed(bet.id)).toBe(false);

    const refund = aWager(WagerKind.REFUND, 'refund', { referenceExternalTransactionId: 'bet' });
    refund.attachReference(bet);
    refund.markProcessed(brl('1.00'), T0);
    await repository.insert(refund);
    expect(await repository.isReversed(bet.id)).toBe(true);

    const rollback = aWager(WagerKind.ROLLBACK, 'rb', { referenceExternalTransactionId: 'bet' });
    rollback.attachReference(bet);
    rollback.markProcessed(brl('1.00'), T0);
    await expect(repository.insert(rollback)).rejects.toThrow(UniqueConstraintViolationError);
  });

  it('updates non-terminal rows and refuses to leave a terminal status', async () => {
    const waiting = pending('rb', 0);
    await repository.insert(waiting);
    await repository.lockById(waiting.id);
    waiting.scheduleNextAttempt(at(10));
    await repository.update(waiting);
    expect((await repository.findById(waiting.id))?.attempts).toBe(2);
    waiting.fail(FailureCode.WALLET_NOT_FOUND, at(10));
    await repository.update(waiting);
    await expect(repository.update(waiting)).rejects.toThrow('terminal status is immutable');
    await expect(repository.update(aProcessedWager(WagerKind.BET, 'ghost'))).rejects.toThrow('not found');
    await repository.releaseLocks();
  });

  it('requires the row lock to update', async () => {
    const waiting = pending('rb', 0);
    await repository.insert(waiting);
    waiting.scheduleNextAttempt(at(10));
    await expect(repository.update(waiting)).rejects.toThrow('must be locked');
    await repository.lockById(waiting.id);
    await repository.releaseLocks();
    await expect(repository.update(waiting)).rejects.toThrow('must be locked');
    expect((await repository.findById(waiting.id))?.attempts).toBe(1);
  });

  it.each([
    ['walletId', { walletId: 'wallet-2' }],
    ['kind', { kind: WagerKind.REFUND }],
    ['money', { money: brl('10.01') }],
    ['payloadHash', { payloadHash: 'other' }],
    ['createdAt', { createdAt: at(1) }],
    ['referenceExternalTransactionId', { referenceExternalTransactionId: 'other' }],
  ] as const)('refuses to change the immutable column %s', async (column, change) => {
    const waiting = pending('rb', 0);
    await repository.insert(waiting);
    await repository.lockById(waiting.id);
    const tampered = WagerTransaction.rehydrate({ ...waiting.toState(), ...change });
    await expect(repository.update(tampered)).rejects.toThrow(`${column} is immutable`);
    await repository.releaseLocks();
  });

  it('links a reference once and never relinks it', async () => {
    const waiting = pending('rb', 0);
    await repository.insert(waiting);
    await repository.lockById(waiting.id);
    const bet = aProcessedWager(WagerKind.BET, 'missing-rb');
    waiting.attachReference(bet);
    await repository.update(waiting);
    const relinked = WagerTransaction.rehydrate({ ...waiting.toState(), referenceTransactionId: 'other' });
    await expect(repository.update(relinked)).rejects.toThrow('referenceTransactionId is immutable');
    await repository.releaseLocks();
  });

  it('locks rows re-entrantly, also for concurrent calls within one scope', async () => {
    const bet = aProcessedWager(WagerKind.BET, 'bet');
    await repository.insert(bet);
    expect(await repository.lockById('missing')).toBeNull();
    const [first, second] = await Promise.all([repository.lockById(bet.id), repository.lockById(bet.id)]);
    expect(first?.id).toBe(bet.id);
    expect(second?.id).toBe(bet.id);
    expect(store.locks.isLocked(bet.id)).toBe(true);
    await repository.releaseLocks();
    expect(store.locks.isLocked(bet.id)).toBe(false);
  });

  it('serializes lockers from different scopes', async () => {
    const bet = aProcessedWager(WagerKind.BET, 'bet');
    await repository.insert(bet);
    const other = new InMemoryWagerTransactionRepository(store);
    await repository.lockById(bet.id);
    let acquired = false;
    const waiting = other.lockById(bet.id).then(() => {
      acquired = true;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);
    await repository.releaseLocks();
    await waiting;
    expect(acquired).toBe(true);
    await other.releaseLocks();
  });

  describe('claimPendingBatch', () => {
    it('claims only due PENDING_REFERENCE rows, oldest first, up to the limit', async () => {
      await repository.insert(pending('late', 30));
      await repository.insert(pending('b', 5));
      await repository.insert(pending('a', 1));
      await repository.insert(pending('c', 9));
      await repository.insert(aProcessedWager(WagerKind.BET, 'bet'));
      expect(await repository.claimPendingBatch({ limit: 2, leaseMs: 60_000, now: at(10) })).toEqual(['id-a', 'id-b']);
    });

    it('never claims a row whose next attempt is still in the future', async () => {
      await repository.insert(pending('due', 10));
      await repository.insert(pending('future', 11));
      expect(await repository.claimPendingBatch({ limit: 10, leaseMs: 60_000, now: at(10) })).toEqual(['id-due']);
      expect(await repository.claimPendingBatch({ limit: 10, leaseMs: 60_000, now: at(11) })).toEqual(['id-future']);
    });

    it('skips leased rows until the lease ends', async () => {
      await repository.insert(pending('a', 0));
      expect(await repository.claimPendingBatch({ limit: 10, leaseMs: 5_000, now: at(1) })).toEqual(['id-a']);
      expect(await repository.claimPendingBatch({ limit: 10, leaseMs: 5_000, now: at(3) })).toEqual([]);
      expect(await repository.claimPendingBatch({ limit: 10, leaseMs: 5_000, now: at(6) })).toEqual(['id-a']);
    });

    it('an update releases the lease, so only nextAttemptAt gates the next claim', async () => {
      const waiting = pending('a', 0);
      await repository.insert(waiting);
      expect(await repository.claimPendingBatch({ limit: 10, leaseMs: 60_000, now: at(1) })).toEqual(['id-a']);
      await repository.lockById(waiting.id);
      waiting.scheduleNextAttempt(at(2));
      await repository.update(waiting);
      await repository.releaseLocks();
      expect(await repository.claimPendingBatch({ limit: 10, leaseMs: 60_000, now: at(2) })).toEqual(['id-a']);
    });

    it('skips row-locked rows (SKIP LOCKED)', async () => {
      const waiting = pending('a', 0);
      await repository.insert(waiting);
      const worker = new InMemoryWagerTransactionRepository(store);
      await worker.lockById(waiting.id);
      expect(await repository.claimPendingBatch({ limit: 10, leaseMs: 1_000, now: at(1) })).toEqual([]);
      await worker.releaseLocks();
    });
  });
});

describe('FakePayloadHasher', () => {
  const payload = {
    providerId: 'p',
    externalTransactionId: 'e',
    playerId: 'pl',
    walletId: 'w',
    roundId: 'r',
    gameId: 'g',
    kind: WagerKind.BET,
    money: { amount: '10.00', currency: 'BRL' },
    referenceExternalTransactionId: null,
  };

  it('is canonical: key order does not matter', () => {
    const hasher = new FakePayloadHasher();
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as typeof payload;
    expect(hasher.hash(reordered)).toBe(hasher.hash(payload));
    expect(hasher.hash(payload)).not.toContain(' ');
  });

  it('changes with any field', () => {
    const hasher = new FakePayloadHasher();
    expect(hasher.hash({ ...payload, money: { amount: '10.01', currency: 'BRL' } })).not.toBe(hasher.hash(payload));
  });
});
