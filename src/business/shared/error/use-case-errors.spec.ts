import { describe, expect, it } from 'bun:test';
import { BusinessRuleError } from './business-rule-error';
import { DomainError } from './domain-error';
import { InvalidRequestError } from './invalid-request-error';
import { UniqueConstraintViolationError } from './unique-constraint-violation-error';
import { WalletNotFoundError } from './wallet-not-found-error';

describe('use case errors', () => {
  it('InvalidRequestError names the field and the reason', () => {
    const error = new InvalidRequestError('money', 'must have 2 decimals');
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ name: 'InvalidRequestError', field: 'money', reason: 'must have 2 decimals' });
    expect(error.message).toBe('Invalid request: money must have 2 decimals');
  });

  it('UniqueConstraintViolationError carries the constraint and is not a business rejection', () => {
    const error = new UniqueConstraintViolationError('UNIQUE(provider_id, idempotency_key)');
    expect(error).toBeInstanceOf(DomainError);
    expect(error).not.toBeInstanceOf(BusinessRuleError);
    expect(error.constraint).toBe('UNIQUE(provider_id, idempotency_key)');
  });

  it('WalletNotFoundError is a business outcome with WALLET_NOT_FOUND', () => {
    const error = new WalletNotFoundError('wallet-1');
    expect(error).toBeInstanceOf(BusinessRuleError);
    expect(error).toMatchObject({ failureCode: 'WALLET_NOT_FOUND', walletId: 'wallet-1' });
  });
});
