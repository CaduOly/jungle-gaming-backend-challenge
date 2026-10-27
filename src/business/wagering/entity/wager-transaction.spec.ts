import { describe, expect, it } from 'bun:test';
import { aProcessedWager, aWager, brl, T0, wagerProps } from '../../../../tests/support/builders/wager-transaction.builder';
import { FailureCode } from '../../shared/error/failure-code';
import { InvalidTransactionStateError } from '../../shared/error/invalid-transaction-state-error';
import { WagerKind } from '../enum/wager-kind';
import { WagerTransactionStatus } from '../enum/wager-transaction-status';
import { InvalidWagerTransactionError } from '../error/invalid-wager-transaction-error';
import { WagerTransaction, type WagerTransactionState } from './wager-transaction';

const T1 = new Date('2026-01-01T00:00:10.000Z');
const T2 = new Date('2026-01-01T00:00:20.000Z');

type Transition = (tx: WagerTransaction) => void;
const TRANSITIONS: Record<'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED', Transition> = {
  PROCESSED: (tx) => tx.markProcessed(brl('1.00'), T1),
  REJECTED: (tx) => tx.reject(FailureCode.INSUFFICIENT_FUNDS, brl('1.00'), T1),
  PENDING_REFERENCE: (tx) => tx.markPendingReference(T1),
  FAILED: (tx) => tx.fail(FailureCode.WALLET_NOT_FOUND, T1),
};

const inStatus = (status: WagerTransactionStatus): WagerTransaction => {
  const tx = aWager(WagerKind.BET, 'ext-1');
  if (status === 'PENDING') return tx;
  if (status === 'PENDING_REFERENCE') {
    tx.markPendingReference(T1);
    return tx;
  }
  if (status === 'FAILED') {
    tx.markPendingReference(T1);
    tx.fail(FailureCode.WALLET_NOT_FOUND, T1);
    return tx;
  }
  TRANSITIONS[status](tx);
  return tx;
};

describe('WagerTransaction', () => {
  describe('create', () => {
    it('starts PENDING with zero attempts and keeps every field', () => {
      const tx = aWager(WagerKind.WIN, 'ext-win', { referenceExternalTransactionId: 'ext-bet' });
      expect(tx.status).toBe('PENDING');
      expect(tx.attempts).toBe(0);
      expect(tx.id).toBe('id-ext-win');
      expect(tx.providerId).toBe('provider-1');
      expect(tx.idempotencyKey).toBe('key-ext-win');
      expect(tx.externalTransactionId).toBe('ext-win');
      expect(tx.playerId).toBe('player-1');
      expect(tx.walletId).toBe('wallet-1');
      expect(tx.roundId).toBe('round-1');
      expect(tx.gameId).toBe('game-1');
      expect(tx.kind).toBe('WIN');
      expect(tx.money).toEqual(brl('10.00'));
      expect(tx.referenceExternalTransactionId).toBe('ext-bet');
      expect(tx.referenceTransactionId).toBeUndefined();
      expect(tx.failureCode).toBeUndefined();
      expect(tx.observedBalance).toBeUndefined();
      expect(tx.nextAttemptAt).toBeUndefined();
      expect(tx.processedAt).toBeUndefined();
      expect(tx.payloadHash).toBe('hash-ext-win');
      expect(tx.createdAt).toEqual(T0);
      expect(tx.isTerminal()).toBe(false);
    });

    it('accepts LOSS with 0.00', () => {
      expect(aWager(WagerKind.LOSS, 'ext', { money: brl('0.00') }).money.isZero()).toBe(true);
    });

    it.each([WagerKind.BET, WagerKind.WIN, WagerKind.REFUND, WagerKind.ROLLBACK, WagerKind.OPENING])(
      'rejects %s with 0.00',
      (kind) => {
        const reference = kind === 'REFUND' || kind === 'ROLLBACK' ? { referenceExternalTransactionId: 'ref' } : {};
        expect(() => aWager(kind, 'ext', { money: brl('0.00'), ...reference })).toThrow(InvalidWagerTransactionError);
      },
    );

    it.each([WagerKind.REFUND, WagerKind.ROLLBACK])('%s requires a reference', (kind) => {
      expect(() => aWager(kind, 'ext')).toThrow(InvalidWagerTransactionError);
      expect(aWager(kind, 'ext', { referenceExternalTransactionId: 'ref' }).requiresReference).toBe(true);
    });

    it.each([WagerKind.OPENING, WagerKind.BET])('%s cannot carry a reference', (kind) => {
      expect(() => aWager(kind, 'ext', { referenceExternalTransactionId: 'ref' })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it.each([WagerKind.WIN, WagerKind.LOSS])('%s may reference the bet or not', (kind) => {
      expect(aWager(kind, 'ext').hasReference).toBe(false);
      expect(aWager(kind, 'ext', { referenceExternalTransactionId: 'bet' }).hasReference).toBe(true);
    });

    it('rejects a self reference and an empty reference', () => {
      expect(() => aWager(WagerKind.REFUND, 'ext', { referenceExternalTransactionId: 'ext' })).toThrow(
        InvalidWagerTransactionError,
      );
      expect(() => aWager(WagerKind.REFUND, 'ext', { referenceExternalTransactionId: ' ' })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it.each([
      'id',
      'providerId',
      'idempotencyKey',
      'externalTransactionId',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
      'payloadHash',
    ] as const)('requires %s', (field) => {
      expect(() => WagerTransaction.create({ ...wagerProps(WagerKind.BET, 'ext'), [field]: '  ' })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it('rejects an unknown kind', () => {
      expect(() => aWager('JACKPOT' as WagerKind, 'ext')).toThrow(InvalidWagerTransactionError);
    });

    it('exposes isOpening', () => {
      expect(aWager(WagerKind.OPENING, 'ext').isOpening).toBe(true);
      expect(aWager(WagerKind.BET, 'ext').isOpening).toBe(false);
    });
  });

  describe('transitions', () => {
    const valid: Array<[WagerTransactionStatus, keyof typeof TRANSITIONS]> = [
      ['PENDING', 'PROCESSED'],
      ['PENDING', 'REJECTED'],
      ['PENDING', 'PENDING_REFERENCE'],
      ['PENDING_REFERENCE', 'PROCESSED'],
      ['PENDING_REFERENCE', 'REJECTED'],
      ['PENDING_REFERENCE', 'FAILED'],
    ];
    const all = Object.keys(TRANSITIONS) as Array<keyof typeof TRANSITIONS>;
    const sources: WagerTransactionStatus[] = ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'];
    const invalid = sources.flatMap((from) =>
      all
        .filter((to) => !valid.some(([validFrom, validTo]) => validFrom === from && validTo === to))
        .map((to): [WagerTransactionStatus, keyof typeof TRANSITIONS] => [from, to]),
    );

    it.each(valid)('allows %s -> %s', (from, to) => {
      const tx = inStatus(from);
      TRANSITIONS[to](tx);
      expect(tx.status).toBe(to);
    });

    it('covers every pair: 6 valid and 14 invalid', () => {
      expect(valid).toHaveLength(6);
      expect(invalid).toHaveLength(14);
    });

    it.each(invalid)('rejects %s -> %s with InvalidTransactionStateError, keeping state', (from, to) => {
      const tx = inStatus(from);
      const before = tx.toState();
      expect(() => TRANSITIONS[to](tx)).toThrow(InvalidTransactionStateError);
      expect(tx.toState()).toEqual(before);
    });

    it.each(['PROCESSED', 'REJECTED', 'FAILED'] as const)('%s is terminal', (status) => {
      const tx = inStatus(status);
      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.scheduleNextAttempt(T2)).toThrow(InvalidTransactionStateError);
    });

    it('markProcessed records observed balance and processedAt', () => {
      const tx = aWager(WagerKind.BET, 'ext');
      tx.markProcessed(brl('90.00'), T1);
      expect(tx.observedBalance).toEqual(brl('90.00'));
      expect(tx.processedAt).toEqual(T1);
      expect(tx.failureCode).toBeUndefined();
    });

    it('reject records failure code, observed balance and time', () => {
      const tx = aWager(WagerKind.BET, 'ext');
      tx.reject(FailureCode.INSUFFICIENT_FUNDS, brl('5.00'), T1);
      expect(tx.status).toBe('REJECTED');
      expect(tx.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(tx.observedBalance).toEqual(brl('5.00'));
      expect(tx.processedAt).toEqual(T1);
    });

    it('pending reference counts attempts and clears the schedule when it settles', () => {
      const tx = aWager(WagerKind.ROLLBACK, 'ext', { referenceExternalTransactionId: 'missing' });
      tx.markPendingReference(T1);
      expect(tx.status).toBe('PENDING_REFERENCE');
      expect(tx.attempts).toBe(1);
      expect(tx.nextAttemptAt).toEqual(T1);
      tx.scheduleNextAttempt(T2);
      expect(tx.attempts).toBe(2);
      expect(tx.nextAttemptAt).toEqual(T2);
      tx.reject(FailureCode.REFERENCE_NOT_FOUND, brl('0.00'), T2);
      expect(tx.nextAttemptAt).toBeUndefined();
      expect(tx.attempts).toBe(2);
    });

    it('scheduleNextAttempt only works in PENDING_REFERENCE', () => {
      expect(() => aWager(WagerKind.BET, 'ext').scheduleNextAttempt(T1)).toThrow(InvalidTransactionStateError);
    });

    it('fail records the code without a balance', () => {
      const tx = inStatus('PENDING_REFERENCE');
      tx.fail(FailureCode.WALLET_NOT_FOUND, T2);
      expect(tx.status).toBe('FAILED');
      expect(tx.failureCode).toBe('WALLET_NOT_FOUND');
      expect(tx.observedBalance).toBeUndefined();
      expect(tx.processedAt).toEqual(T2);
    });
  });

  describe('attachReference', () => {
    it('links the internal id of the matching reference', () => {
      const bet = aProcessedWager(WagerKind.BET, 'bet');
      const refund = aWager(WagerKind.REFUND, 'refund', { referenceExternalTransactionId: 'bet' });
      refund.attachReference(bet);
      expect(refund.referenceTransactionId).toBe('id-bet');
    });

    it('rejects a reference with another external id', () => {
      const other = aProcessedWager(WagerKind.BET, 'other');
      const refund = aWager(WagerKind.REFUND, 'refund', { referenceExternalTransactionId: 'bet' });
      expect(() => refund.attachReference(other)).toThrow(InvalidWagerTransactionError);
    });

    it('is not allowed on a terminal transaction', () => {
      const bet = aProcessedWager(WagerKind.BET, 'bet');
      const refund = aWager(WagerKind.REFUND, 'refund', { referenceExternalTransactionId: 'bet' });
      refund.reject(FailureCode.AMOUNT_MISMATCH, brl('1.00'), T1);
      expect(() => refund.attachReference(bet)).toThrow(InvalidTransactionStateError);
    });
  });

  describe('balance semantics', () => {
    it('LOSS does not affect the balance; every other kind does', () => {
      expect(aWager(WagerKind.LOSS, 'ext').affectsBalance).toBe(false);
      for (const kind of [WagerKind.BET, WagerKind.WIN, WagerKind.OPENING] as const) {
        expect(aWager(kind, 'ext').affectsBalance).toBe(true);
      }
    });

    it.each([
      [WagerKind.BET, 'DEBIT'],
      [WagerKind.WIN, 'CREDIT'],
      [WagerKind.OPENING, 'CREDIT'],
    ] as const)('%s moves as %s', (kind, direction) => {
      expect(aWager(kind, 'ext').ledgerDirectionFor()).toBe(direction);
    });

    it('REFUND credits', () => {
      const bet = aProcessedWager(WagerKind.BET, 'bet');
      expect(aWager(WagerKind.REFUND, 'r', { referenceExternalTransactionId: 'bet' }).ledgerDirectionFor(bet)).toBe(
        'CREDIT',
      );
    });

    it.each([
      [WagerKind.BET, 'CREDIT'],
      [WagerKind.WIN, 'DEBIT'],
      [WagerKind.REFUND, 'DEBIT'],
    ] as const)('ROLLBACK of %s moves as %s', (referenceKind, direction) => {
      const referenceProps = referenceKind === 'REFUND' ? { referenceExternalTransactionId: 'bet' } : {};
      const reference = aProcessedWager(referenceKind, 'ref', referenceProps);
      const rollback = aWager(WagerKind.ROLLBACK, 'rb', { referenceExternalTransactionId: 'ref' });
      expect(rollback.ledgerDirectionFor(reference)).toBe(direction);
    });

    it('ROLLBACK without a reversible reference has no direction', () => {
      const rollback = aWager(WagerKind.ROLLBACK, 'rb', { referenceExternalTransactionId: 'ref' });
      expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
      const loss = aProcessedWager(WagerKind.LOSS, 'ref');
      expect(() => rollback.ledgerDirectionFor(loss)).toThrow(InvalidWagerTransactionError);
      const other = aProcessedWager(WagerKind.ROLLBACK, 'ref', { referenceExternalTransactionId: 'x' });
      expect(() => rollback.ledgerDirectionFor(other)).toThrow(InvalidWagerTransactionError);
    });

    it('LOSS has no direction', () => {
      expect(() => aWager(WagerKind.LOSS, 'ext').ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    });
  });

  it('matchesPayload compares the hash', () => {
    const tx = aWager(WagerKind.BET, 'ext');
    expect(tx.matchesPayload('hash-ext')).toBe(true);
    expect(tx.matchesPayload('other')).toBe(false);
  });

  it('rehydrates any persisted state without revalidating, and round-trips toState', () => {
    const state: WagerTransactionState = {
      ...wagerProps(WagerKind.REFUND, 'ext', { referenceExternalTransactionId: 'bet' }),
      referenceTransactionId: 'id-bet',
      status: WagerTransactionStatus.REJECTED,
      failureCode: FailureCode.ALREADY_REVERSED,
      observedBalance: brl('3.00'),
      attempts: 4,
      nextAttemptAt: undefined,
      processedAt: T1,
    };
    const tx = WagerTransaction.rehydrate(state);
    expect(tx.toState()).toEqual(state);
    expect(tx.isTerminal()).toBe(true);
  });

  it('does not leak mutable dates', () => {
    const tx = aWager(WagerKind.BET, 'ext');
    tx.createdAt.setFullYear(2000);
    expect(tx.createdAt).toEqual(T0);
  });

  it('copies createdAt on create, so the caller cannot rewrite it', () => {
    const createdAt = new Date(T0);
    const tx = WagerTransaction.create(wagerProps(WagerKind.BET, 'ext', { createdAt }));
    createdAt.setFullYear(2000);
    expect(tx.createdAt).toEqual(T0);
    expect(tx.toState().createdAt).toEqual(T0);
  });

  it('copies every date on rehydrate', () => {
    const createdAt = new Date(T0);
    const nextAttemptAt = new Date(T1);
    const processedAt = new Date(T1);
    const pending = WagerTransaction.rehydrate({
      ...wagerProps(WagerKind.WIN, 'ext', { referenceExternalTransactionId: 'bet', createdAt }),
      status: WagerTransactionStatus.PENDING_REFERENCE,
      attempts: 1,
      nextAttemptAt,
    });
    const processed = WagerTransaction.rehydrate({
      ...wagerProps(WagerKind.BET, 'bet', { createdAt }),
      status: WagerTransactionStatus.PROCESSED,
      observedBalance: brl('1.00'),
      attempts: 0,
      processedAt,
    });
    for (const date of [createdAt, nextAttemptAt, processedAt]) date.setFullYear(2000);
    expect(pending.createdAt).toEqual(T0);
    expect(pending.nextAttemptAt).toEqual(T1);
    expect(processed.processedAt).toEqual(T1);
    expect(processed.toState().createdAt).toEqual(T0);
  });
});
