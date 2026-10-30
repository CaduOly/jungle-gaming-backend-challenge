import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { reconcileInMemoryWallet } from '../../../../tests/support/assertions/reconcile-in-memory-wallet';
import { brl, T0, wagerProps } from '../../../../tests/support/builders/wager-transaction.builder';
import { InMemoryLedger } from '../../../../tests/support/fakes/in-memory-ledger';
import {
  InMemoryWagerTransactionRepository,
  InMemoryWagerTransactionStore,
} from '../../../../tests/support/fakes/in-memory-wager-transaction-repository';
import type { FailureCode } from '../../shared/error/failure-code';
import { Wallet } from '../../wallet/entity/wallet';
import { type CreateWagerTransactionProps, WagerTransaction } from '../entity/wager-transaction';
import type { WagerKind } from '../enum/wager-kind';
import { ReferenceResolver } from './reference-resolver';
import { WagerSettlement } from './wager-settlement';

/** Resolver + settlement ligados sobre os fakes, do jeito que o ProcessWagerTransaction orquestra. */
describe('wagering rules end to end (domain only)', () => {
  let wallet: Wallet;
  let ledger: InMemoryLedger;
  let transactions: InMemoryWagerTransactionRepository;
  let resolver: ReferenceResolver;
  const settlement = new WagerSettlement();

  beforeEach(async () => {
    const opened = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('100.00'),
      openingTransactionId: 'opening',
      at: T0,
    });
    wallet = opened.wallet;
    ledger = new InMemoryLedger();
    if (opened.openingEntry) await ledger.append(opened.openingEntry);
    transactions = new InMemoryWagerTransactionRepository(new InMemoryWagerTransactionStore());
    resolver = new ReferenceResolver(transactions);
  });

  const submit = async (
    kind: WagerKind,
    ext: string,
    overrides: Partial<CreateWagerTransactionProps> = {},
  ): Promise<{ status: string; failureCode?: FailureCode }> => {
    const transaction = WagerTransaction.create(wagerProps(kind, ext, overrides));
    const resolution = await resolver.resolve(transaction);
    if (resolution.type === 'Missing' || resolution.type === 'StillPending') {
      transaction.markPendingReference(T0);
    } else if (resolution.type === 'Rejected') {
      transaction.reject(resolution.code, wallet.balance, T0);
    } else {
      const outcome = settlement.settle({ transaction, wallet, reference: resolution.reference, at: T0 });
      if (outcome.type === 'Processed' && outcome.entry) await ledger.append(outcome.entry);
    }
    await transactions.insert(transaction);
    return { status: transaction.status, failureCode: transaction.failureCode };
  };

  afterEach(async () => {
    expect((await reconcileInMemoryWallet(wallet, ledger)).consistent).toBe(true);
  });

  it('BET -> REFUND -> ROLLBACK of the REFUND leaves the BET debited and not refundable again', async () => {
    expect(await submit('BET', 'bet', { money: brl('30.00') })).toEqual({ status: 'PROCESSED', failureCode: undefined });
    expect(wallet.balance).toEqual(brl('70.00'));
    expect((await submit('REFUND', 'refund', { money: brl('30.00'), referenceExternalTransactionId: 'bet' })).status).toBe(
      'PROCESSED',
    );
    expect(wallet.balance).toEqual(brl('100.00'));
    expect(
      (await submit('ROLLBACK', 'rb', { money: brl('30.00'), referenceExternalTransactionId: 'refund' })).status,
    ).toBe('PROCESSED');
    expect(wallet.balance).toEqual(brl('70.00'));

    expect(await submit('REFUND', 'refund-2', { money: brl('30.00'), referenceExternalTransactionId: 'bet' })).toEqual({
      status: 'REJECTED',
      failureCode: 'ALREADY_REVERSED',
    });
    expect(await submit('ROLLBACK', 'rb-2', { money: brl('30.00'), referenceExternalTransactionId: 'bet' })).toEqual({
      status: 'REJECTED',
      failureCode: 'ALREADY_REVERSED',
    });
    expect(await submit('ROLLBACK', 'rb-3', { money: brl('30.00'), referenceExternalTransactionId: 'refund' })).toEqual({
      status: 'REJECTED',
      failureCode: 'ALREADY_REVERSED',
    });
    expect(wallet.balance).toEqual(brl('70.00'));
  });

  it('REFUND then ROLLBACK of the same BET: the reversal happens only once in total', async () => {
    await submit('BET', 'bet', { money: brl('10.00') });
    await submit('REFUND', 'refund', { money: brl('10.00'), referenceExternalTransactionId: 'bet' });
    expect(await submit('ROLLBACK', 'rb', { money: brl('10.00'), referenceExternalTransactionId: 'bet' })).toEqual({
      status: 'REJECTED',
      failureCode: 'ALREADY_REVERSED',
    });
    expect(wallet.balance).toEqual(brl('100.00'));
  });

  it('rejects a partial refund with AMOUNT_MISMATCH', async () => {
    await submit('BET', 'bet', { money: brl('10.00') });
    expect(await submit('REFUND', 'refund', { money: brl('5.00'), referenceExternalTransactionId: 'bet' })).toEqual({
      status: 'REJECTED',
      failureCode: 'AMOUNT_MISMATCH',
    });
    expect(wallet.balance).toEqual(brl('90.00'));
  });

  it('a reversal that would overdraw is rejected with REVERSAL_INSUFFICIENT_FUNDS', async () => {
    await submit('WIN', 'win', { money: brl('50.00') });
    await submit('BET', 'bet', { money: brl('120.00') });
    expect(wallet.balance).toEqual(brl('30.00'));
    expect(await submit('ROLLBACK', 'rb', { money: brl('50.00'), referenceExternalTransactionId: 'win' })).toEqual({
      status: 'REJECTED',
      failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
    });
    expect(await submit('BET', 'bet-2', { money: brl('30.01') })).toEqual({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
  });

  it('a ROLLBACK that arrives before its BET waits as PENDING_REFERENCE', async () => {
    expect((await submit('ROLLBACK', 'rb', { referenceExternalTransactionId: 'bet' })).status).toBe(
      'PENDING_REFERENCE',
    );
    expect((await submit('WIN', 'win', { referenceExternalTransactionId: 'bet' })).status).toBe('PENDING_REFERENCE');
    expect(wallet.balance).toEqual(brl('100.00'));
  });

  it('a dependent of a rejected BET is rejected with REFERENCE_NOT_PROCESSED', async () => {
    await submit('BET', 'bet', { money: brl('500.00') });
    expect(await submit('REFUND', 'refund', { money: brl('500.00'), referenceExternalTransactionId: 'bet' })).toEqual({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_PROCESSED',
    });
  });

  it('LOSS records the outcome without moving the balance', async () => {
    await submit('BET', 'bet', { money: brl('10.00') });
    expect((await submit('LOSS', 'loss', { money: brl('0.00'), referenceExternalTransactionId: 'bet' })).status).toBe(
      'PROCESSED',
    );
    expect(wallet.balance).toEqual(brl('90.00'));
    expect(wallet.version).toBe(2);
  });
});
