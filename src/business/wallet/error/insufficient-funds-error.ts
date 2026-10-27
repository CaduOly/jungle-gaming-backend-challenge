import { BusinessRuleError } from '../../shared/error/business-rule-error';
import type { FailureCode } from '../../shared/error/failure-code';

export type InsufficientFundsCode = Extract<FailureCode, 'INSUFFICIENT_FUNDS' | 'REVERSAL_INSUFFICIENT_FUNDS'>;

export class InsufficientFundsError extends BusinessRuleError {
  constructor(
    code: InsufficientFundsCode,
    readonly walletId: string,
  ) {
    super(code, `Wallet ${walletId} has insufficient funds`);
  }
}
