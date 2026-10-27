import { DomainError } from '../../shared/error/domain-error';

export class InvalidLedgerEntryError extends DomainError {
  constructor(reason: string) {
    super(`Invalid ledger entry: ${reason}`);
  }
}
