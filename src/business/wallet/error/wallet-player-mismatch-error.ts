import { BusinessRuleError } from '../../shared/error/business-rule-error';
import { FailureCode } from '../../shared/error/failure-code';

export class WalletPlayerMismatchError extends BusinessRuleError {
  constructor(
    readonly walletId: string,
    readonly playerId: string,
  ) {
    super(FailureCode.WALLET_PLAYER_MISMATCH, `Wallet ${walletId} does not belong to player ${playerId}`);
  }
}
