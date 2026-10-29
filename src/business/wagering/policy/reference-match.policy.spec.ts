import { describe, expect, it } from 'bun:test';
import { aProcessedWager, aWager, usd } from '../../../../tests/support/builders/wager-transaction.builder';
import { WagerKind } from '../enum/wager-kind';
import { checkReferenceMatch } from './reference-match.policy';

const refund = (overrides = {}) =>
  aWager(WagerKind.REFUND, 'refund', { referenceExternalTransactionId: 'bet', ...overrides });

describe('checkReferenceMatch', () => {
  it('accepts a reference with the same provider, player, wallet, round and currency', () => {
    expect(checkReferenceMatch(refund(), aProcessedWager(WagerKind.BET, 'bet'))).toBeNull();
  });

  it('ignores the game id', () => {
    expect(checkReferenceMatch(refund({ gameId: 'other' }), aProcessedWager(WagerKind.BET, 'bet'))).toBeNull();
  });

  it.each(['providerId', 'playerId', 'walletId', 'roundId'] as const)('rejects a different %s', (field) => {
    const reference = aProcessedWager(WagerKind.BET, 'bet', { [field]: 'someone-else' });
    expect(checkReferenceMatch(refund(), reference)).toBe('REFERENCE_MISMATCH');
  });

  it('rejects a different currency with CURRENCY_MISMATCH', () => {
    const reference = aProcessedWager(WagerKind.BET, 'bet', { money: usd('10.00') });
    expect(checkReferenceMatch(refund(), reference)).toBe('CURRENCY_MISMATCH');
  });

  it('reports ownership before currency', () => {
    const reference = aProcessedWager(WagerKind.BET, 'bet', { money: usd('10.00'), roundId: 'other' });
    expect(checkReferenceMatch(refund(), reference)).toBe('REFERENCE_MISMATCH');
  });
});
