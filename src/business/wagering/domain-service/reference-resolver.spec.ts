import { beforeEach, describe, expect, it } from 'bun:test';
import { aProcessedWager, aWager, brl, T0, usd } from '../../../../tests/support/builders/wager-transaction.builder';
import {
  InMemoryWagerTransactionRepository,
  InMemoryWagerTransactionStore,
} from '../../../../tests/support/fakes/in-memory-wager-transaction-repository';
import { FailureCode } from '../../shared/error/failure-code';
import type { WagerTransaction } from '../entity/wager-transaction';
import { WagerKind } from '../enum/wager-kind';
import { ReferenceResolver } from './reference-resolver';

describe('ReferenceResolver', () => {
  let repository: InMemoryWagerTransactionRepository;
  let resolver: ReferenceResolver;

  beforeEach(() => {
    repository = new InMemoryWagerTransactionRepository(new InMemoryWagerTransactionStore());
    resolver = new ReferenceResolver(repository);
  });

  const persist = async (transaction: WagerTransaction): Promise<WagerTransaction> => {
    await repository.insert(transaction);
    return transaction;
  };
  const refund = (overrides = {}) =>
    aWager(WagerKind.REFUND, 'refund', { referenceExternalTransactionId: 'bet', ...overrides });

  it('resolves to null when there is no reference', async () => {
    expect(await resolver.resolve(aWager(WagerKind.BET, 'bet'))).toEqual({ type: 'Resolved', reference: null });
  });

  it.each([
    ['REFUND', 'refund'],
    ['ROLLBACK', 'rollback'],
    ['WIN', 'win'],
    ['LOSS', 'loss'],
  ] as const)('returns Missing for a %s whose reference does not exist yet', async (kind, ext) => {
    expect(await resolver.resolve(aWager(kind, ext, { referenceExternalTransactionId: 'bet' }))).toEqual({
      type: 'Missing',
    });
  });

  it('looks the reference up within the same provider', async () => {
    await persist(aProcessedWager(WagerKind.BET, 'bet', { providerId: 'provider-2' }));
    expect((await resolver.resolve(refund())).type).toBe('Missing');
  });

  it('returns StillPending when the reference waits for its own reference', async () => {
    const pendingWin = aWager(WagerKind.WIN, 'bet', { referenceExternalTransactionId: 'older' });
    pendingWin.markPendingReference(T0);
    await persist(pendingWin);
    const rollback = aWager(WagerKind.ROLLBACK, 'rb', { referenceExternalTransactionId: 'bet' });
    expect(await resolver.resolve(rollback)).toMatchObject({ type: 'StillPending' });
  });

  it('rejects with REFERENCE_NOT_PROCESSED when the reference was rejected', async () => {
    const bet = aWager(WagerKind.BET, 'bet');
    bet.reject(FailureCode.INSUFFICIENT_FUNDS, brl('0.00'), T0);
    await persist(bet);
    expect(await resolver.resolve(refund())).toMatchObject({ type: 'Rejected', code: 'REFERENCE_NOT_PROCESSED' });
  });

  it('rejects with REFERENCE_NOT_PROCESSED when the reference failed', async () => {
    const win = aWager(WagerKind.WIN, 'bet', { referenceExternalTransactionId: 'x' });
    win.markPendingReference(T0);
    win.fail(FailureCode.WALLET_NOT_FOUND, T0);
    await persist(win);
    const rollback = aWager(WagerKind.ROLLBACK, 'rb', { referenceExternalTransactionId: 'bet' });
    expect(await resolver.resolve(rollback)).toMatchObject({ type: 'Rejected', code: 'REFERENCE_NOT_PROCESSED' });
  });

  it.each([
    ['REJECTED', { playerId: 'player-2' }],
    ['FAILED', { roundId: 'round-2' }],
    ['PENDING_REFERENCE', { walletId: 'wallet-2' }],
  ] as const)(
    'answers REFERENCE_MISMATCH for a foreign %s reference, never leaking its status',
    async (status, owner) => {
      const foreign = aWager(WagerKind.WIN, 'bet', { referenceExternalTransactionId: 'older', ...owner });
      if (status === 'REJECTED') foreign.reject(FailureCode.INSUFFICIENT_FUNDS, brl('0.00'), T0);
      else foreign.markPendingReference(T0);
      if (status === 'FAILED') foreign.fail(FailureCode.WALLET_NOT_FOUND, T0);
      await persist(foreign);
      const rollback = aWager(WagerKind.ROLLBACK, 'rb', { referenceExternalTransactionId: 'bet' });
      expect(await resolver.resolve(rollback)).toMatchObject({ type: 'Rejected', code: 'REFERENCE_MISMATCH' });
    },
  );

  it('answers CURRENCY_MISMATCH before REFERENCE_NOT_PROCESSED for a rejected reference in another currency', async () => {
    const bet = aWager(WagerKind.BET, 'bet', { money: usd('10.00') });
    bet.reject(FailureCode.CURRENCY_MISMATCH, brl('0.00'), T0);
    await persist(bet);
    expect(await resolver.resolve(refund())).toMatchObject({ type: 'Rejected', code: 'CURRENCY_MISMATCH' });
  });

  it.each([
    [WagerKind.WIN, WagerKind.LOSS],
    [WagerKind.LOSS, WagerKind.WIN],
  ] as const)('rejects a %s that references a %s with INVALID_REFERENCE_KIND', async (kind, referenceKind) => {
    await persist(aProcessedWager(referenceKind, 'ref'));
    const transaction = aWager(kind, 'tx', { referenceExternalTransactionId: 'ref' });
    expect(await resolver.resolve(transaction)).toMatchObject({ type: 'Rejected', code: 'INVALID_REFERENCE_KIND' });
  });

  it('resolves a processed reference that passes every policy', async () => {
    const bet = await persist(aProcessedWager(WagerKind.BET, 'bet'));
    const resolution = await resolver.resolve(refund());
    expect(resolution.type).toBe('Resolved');
    if (resolution.type === 'Resolved') expect(resolution.reference?.id).toBe(bet.id);
  });

  it('rejects with REFERENCE_MISMATCH for another round', async () => {
    await persist(aProcessedWager(WagerKind.BET, 'bet', { roundId: 'round-2' }));
    expect(await resolver.resolve(refund())).toMatchObject({ type: 'Rejected', code: 'REFERENCE_MISMATCH' });
  });

  it('rejects with CURRENCY_MISMATCH for another currency', async () => {
    await persist(aProcessedWager(WagerKind.BET, 'bet', { money: usd('10.00') }));
    expect(await resolver.resolve(refund())).toMatchObject({ type: 'Rejected', code: 'CURRENCY_MISMATCH' });
  });

  it('rejects a WIN that references something other than a BET', async () => {
    await persist(aProcessedWager(WagerKind.WIN, 'other-win'));
    const win = aWager(WagerKind.WIN, 'win', { referenceExternalTransactionId: 'other-win' });
    expect(await resolver.resolve(win)).toMatchObject({ type: 'Rejected', code: 'INVALID_REFERENCE_KIND' });
  });

  it('resolves a WIN referencing the BET of the round, whatever the amount', async () => {
    await persist(aProcessedWager(WagerKind.BET, 'bet'));
    const win = aWager(WagerKind.WIN, 'win', { referenceExternalTransactionId: 'bet', money: brl('55.00') });
    expect((await resolver.resolve(win)).type).toBe('Resolved');
  });

  it('rejects a REFUND of a WIN with INVALID_REFERENCE_KIND', async () => {
    await persist(aProcessedWager(WagerKind.WIN, 'bet'));
    expect(await resolver.resolve(refund())).toMatchObject({ type: 'Rejected', code: 'INVALID_REFERENCE_KIND' });
  });

  it('rejects a reversal with a different amount', async () => {
    await persist(aProcessedWager(WagerKind.BET, 'bet'));
    expect(await resolver.resolve(refund({ money: brl('9.99') }))).toMatchObject({
      type: 'Rejected',
      code: 'AMOUNT_MISMATCH',
    });
  });

  it('rejects a second reversal of the same reference with ALREADY_REVERSED', async () => {
    const bet = await persist(aProcessedWager(WagerKind.BET, 'bet'));
    const first = refund();
    first.attachReference(bet);
    first.markProcessed(brl('100.00'), T0);
    await persist(first);
    const rollback = aWager(WagerKind.ROLLBACK, 'rb', { referenceExternalTransactionId: 'bet' });
    expect(await resolver.resolve(rollback)).toMatchObject({ type: 'Rejected', code: 'ALREADY_REVERSED' });
  });

  it('does not count a rejected reversal as a reversal', async () => {
    const bet = await persist(aProcessedWager(WagerKind.BET, 'bet'));
    const rejected = refund({ money: brl('1.00') });
    rejected.attachReference(bet);
    rejected.reject(FailureCode.AMOUNT_MISMATCH, brl('100.00'), T0);
    await persist(rejected);
    const retry = aWager(WagerKind.REFUND, 'refund-2', { referenceExternalTransactionId: 'bet' });
    expect((await resolver.resolve(retry)).type).toBe('Resolved');
  });
});
