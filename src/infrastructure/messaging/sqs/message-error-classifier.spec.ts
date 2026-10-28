import { describe, expect, it } from 'bun:test';
import { InboxMessageAlreadyProcessedError } from '../../../business/messaging/error/inbox-message-already-processed-error';
import { InboxPayloadMismatchError } from '../../../business/messaging/error/inbox-payload-mismatch-error';
import { CurrencyMismatchError } from '../../../business/shared/error/currency-mismatch-error';
import { InvalidMoneyAmountError } from '../../../business/shared/error/invalid-money-amount-error';
import { PermanentInfrastructureError } from '../../error/permanent-infrastructure-error';
import { TransientInfrastructureError } from '../../error/transient-infrastructure-error';
import { InvalidMessageError } from './invalid-message-error';
import { classifyMessageError } from './message-error-classifier';

describe('classifyMessageError', () => {
  it('acks business rule rejections and already processed inbox messages', () => {
    expect(classifyMessageError(new CurrencyMismatchError('BRL', 'USD'))).toEqual({
      outcome: { kind: 'ack' },
      transient: false,
    });
    expect(classifyMessageError(new InboxMessageAlreadyProcessedError('c', 'm')).outcome).toEqual({ kind: 'ack' });
  });

  it('retries transient infrastructure failures and flags them for the circuit breaker', () => {
    const error = new TransientInfrastructureError('lock timeout', '55P03', { cause: undefined });
    expect(classifyMessageError(error)).toEqual({ outcome: { kind: 'retry' }, transient: true });
  });

  it.each([
    [new InvalidMessageError('invalid_schema', 'kind is required'), 'invalid_schema'],
    [new InvalidMessageError('contract_violation', 'OPENING is internal'), 'contract_violation'],
    [new InboxPayloadMismatchError('wager-transactions', 'msg-1'), 'inbox_payload_mismatch'],
    [new PermanentInfrastructureError('ledger is immutable', '23001', { cause: undefined }), 'permanent_infrastructure'],
    [new InvalidMoneyAmountError('1.234'), 'contract_violation'],
  ])('dead-letters %p as %p', (error, reason) => {
    const { outcome, transient } = classifyMessageError(error);
    expect(outcome).toMatchObject({ kind: 'dead-letter', reason, detail: (error as Error).message });
    expect(transient).toBe(false);
  });

  it('retries unknown errors and leaves the final say to the redrive policy', () => {
    expect(classifyMessageError(new Error('???'))).toEqual({ outcome: { kind: 'retry' }, transient: false });
    expect(classifyMessageError('a string')).toEqual({ outcome: { kind: 'retry' }, transient: false });
  });
});
