import { describe, expect, it } from 'bun:test';
import { aProcessedWager, aWager, brl } from '../../../../tests/support/builders/wager-transaction.builder';
import { WagerKind } from '../enum/wager-kind';
import { checkReversal, isReferenceKindAllowed } from './reversal.policy';

const reference = (kind: WagerKind) =>
  aProcessedWager(kind, 'ref', kind === 'REFUND' || kind === 'ROLLBACK' ? { referenceExternalTransactionId: 'x' } : {});
const reversal = (kind: typeof WagerKind.REFUND | typeof WagerKind.ROLLBACK, amount = '10.00') =>
  aWager(kind, 'rev', { referenceExternalTransactionId: 'ref', money: brl(amount) });

describe('reversal policy', () => {
  it.each([
    ['REFUND', 'BET', true],
    ['REFUND', 'WIN', false],
    ['REFUND', 'REFUND', false],
    ['REFUND', 'ROLLBACK', false],
    ['REFUND', 'LOSS', false],
    ['REFUND', 'OPENING', false],
    ['ROLLBACK', 'BET', true],
    ['ROLLBACK', 'WIN', true],
    ['ROLLBACK', 'REFUND', true],
    ['ROLLBACK', 'ROLLBACK', false],
    ['ROLLBACK', 'LOSS', false],
    ['ROLLBACK', 'OPENING', false],
    ['WIN', 'BET', true],
    ['WIN', 'WIN', false],
    ['LOSS', 'BET', true],
    ['LOSS', 'REFUND', false],
    ['BET', 'BET', false],
    ['OPENING', 'BET', false],
  ] as const)('%s referencing %s allowed: %p', (kind, referenceKind, allowed) => {
    expect(isReferenceKindAllowed(kind, referenceKind)).toBe(allowed);
  });

  it.each([
    ['REFUND', 'BET'],
    ['ROLLBACK', 'BET'],
    ['ROLLBACK', 'WIN'],
    ['ROLLBACK', 'REFUND'],
  ] as const)('accepts %s of a %s for the full amount', (kind, referenceKind) => {
    expect(checkReversal(reversal(kind), reference(referenceKind), false)).toBeNull();
  });

  it.each([
    ['REFUND', 'WIN'],
    ['ROLLBACK', 'ROLLBACK'],
    ['ROLLBACK', 'LOSS'],
  ] as const)('rejects %s of a %s with INVALID_REFERENCE_KIND', (kind, referenceKind) => {
    expect(checkReversal(reversal(kind), reference(referenceKind), false)).toBe('INVALID_REFERENCE_KIND');
  });

  it.each(['REFUND', 'ROLLBACK'] as const)('%s of an already reversed reference is ALREADY_REVERSED', (kind) => {
    expect(checkReversal(reversal(kind), reference('BET'), true)).toBe('ALREADY_REVERSED');
  });

  it.each(['9.99', '10.01'])('rejects a partial or larger amount %p with AMOUNT_MISMATCH', (amount) => {
    expect(checkReversal(reversal('REFUND', amount), reference('BET'), false)).toBe('AMOUNT_MISMATCH');
  });

  it('checks kind first, then reversal, then amount', () => {
    expect(checkReversal(reversal('REFUND', '1.00'), reference('WIN'), true)).toBe('INVALID_REFERENCE_KIND');
    expect(checkReversal(reversal('REFUND', '1.00'), reference('BET'), true)).toBe('ALREADY_REVERSED');
  });
});
