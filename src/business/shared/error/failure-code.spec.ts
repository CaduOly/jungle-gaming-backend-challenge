import { describe, expect, it } from 'bun:test';
import { FailureCode, isFailureCode } from './failure-code';

describe('FailureCode', () => {
  it('lists exactly the failure codes of the plan', () => {
    expect<string[]>(Object.values(FailureCode).sort()).toEqual(
      [
        'INSUFFICIENT_FUNDS',
        'REVERSAL_INSUFFICIENT_FUNDS',
        'CURRENCY_MISMATCH',
        'WALLET_NOT_FOUND',
        'WALLET_PLAYER_MISMATCH',
        'PROVIDER_IDENTITY_MISMATCH',
        'REFERENCE_NOT_FOUND',
        'REFERENCE_MISMATCH',
        'INVALID_REFERENCE_KIND',
        'REFERENCE_NOT_PROCESSED',
        'ALREADY_REVERSED',
        'AMOUNT_MISMATCH',
        'DUPLICATE_EXTERNAL_TRANSACTION',
        'IDEMPOTENCY_CONFLICT',
      ].sort(),
    );
  });

  it('maps every key to itself', () => {
    for (const [key, value] of Object.entries(FailureCode)) expect<string>(value).toBe(key);
  });

  it('isFailureCode narrows only known codes', () => {
    expect(isFailureCode('INSUFFICIENT_FUNDS')).toBe(true);
    expect(isFailureCode('insufficient_funds')).toBe(false);
    expect(isFailureCode('toString')).toBe(false);
    expect(isFailureCode(42)).toBe(false);
  });
});
