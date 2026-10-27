import { BusinessRuleError } from '../../shared/error/business-rule-error';
import { FailureCode } from '../../shared/error/failure-code';

export class WalletNotFoundError extends BusinessRuleError {
  constructor(readonly walletId: string) {
    super(FailureCode.WALLET_NOT_FOUND, `Wallet ${walletId} not found`);
  }
}
