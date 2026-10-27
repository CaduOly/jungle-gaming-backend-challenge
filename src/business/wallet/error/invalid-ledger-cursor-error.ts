import { DomainError } from '../../shared/error/domain-error';

export class InvalidLedgerCursorError extends DomainError {
  constructor() {
    super('Invalid ledger cursor');
  }
}
