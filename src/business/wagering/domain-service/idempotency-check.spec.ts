import { beforeEach, describe, expect, it } from 'bun:test';
import { aWager, brl, T0 } from '../../../../tests/support/builders/wager-transaction.builder';
import {
  InMemoryWagerTransactionRepository,
  InMemoryWagerTransactionStore,
} from '../../../../tests/support/fakes/in-memory-wager-transaction-repository';
import { WagerKind } from '../enum/wager-kind';
import { IdempotencyCheck } from './idempotency-check';

describe('IdempotencyCheck', () => {
  let repository: InMemoryWagerTransactionRepository;
  let check: IdempotencyCheck;

  beforeEach(async () => {
    repository = new InMemoryWagerTransactionRepository(new InMemoryWagerTransactionStore());
    check = new IdempotencyCheck(repository);
    const bet = aWager(WagerKind.BET, 'ext-1');
    bet.markProcessed(brl('90.00'), T0);
    await repository.insert(bet);
  });

  const request = (overrides = {}) => ({
    providerId: 'provider-1',
    idempotencyKey: 'key-ext-1',
    externalTransactionId: 'ext-1',
    payloadHash: 'hash-ext-1',
    ...overrides,
  });

  it('returns New for an unseen key and external id', async () => {
    expect(await check.check(request({ idempotencyKey: 'k2', externalTransactionId: 'ext-2' }))).toEqual({
      type: 'New',
    });
  });

  it('returns Replay with the original transaction for the same key and payload', async () => {
    const decision = await check.check(request());
    expect(decision.type).toBe('Replay');
    if (decision.type === 'Replay') {
      expect(decision.existing.id).toBe('id-ext-1');
      expect(decision.existing.observedBalance).toEqual(brl('90.00'));
    }
  });

  it('returns IDEMPOTENCY_CONFLICT for the same key with a divergent payload', async () => {
    const decision = await check.check(request({ payloadHash: 'different' }));
    expect(decision).toMatchObject({ type: 'Conflict', code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('returns DUPLICATE_EXTERNAL_TRANSACTION for the same external id under another key', async () => {
    const decision = await check.check(request({ idempotencyKey: 'another-key', payloadHash: 'hash-ext-1' }));
    expect(decision).toMatchObject({ type: 'Conflict', code: 'DUPLICATE_EXTERNAL_TRANSACTION' });
  });

  it('scopes keys and external ids by provider', async () => {
    expect(await check.check(request({ providerId: 'provider-2' }))).toEqual({ type: 'New' });
  });
});
