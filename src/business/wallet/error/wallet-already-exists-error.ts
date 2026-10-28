import { DomainError } from '../../shared/error/domain-error';

export class WalletAlreadyExistsError extends DomainError {
  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}
