import { error, type IDetailMessage, warning } from './detail-message';

const NS = 'WAGERING';

export class WageringDetailMessage {
  static readonly INSUFFICIENT_FUNDS: IDetailMessage = error(NS, 'INSUFFICIENT_FUNDS');
  static readonly REVERSAL_INSUFFICIENT_FUNDS: IDetailMessage = error(NS, 'REVERSAL_INSUFFICIENT_FUNDS');
  static readonly CURRENCY_MISMATCH: IDetailMessage = error(NS, 'CURRENCY_MISMATCH');
  static readonly PROVIDER_IDENTITY_MISMATCH: IDetailMessage = error(NS, 'PROVIDER_IDENTITY_MISMATCH');
  static readonly REFERENCE_NOT_FOUND: IDetailMessage = error(NS, 'REFERENCE_NOT_FOUND');
  static readonly REFERENCE_MISMATCH: IDetailMessage = error(NS, 'REFERENCE_MISMATCH');
  static readonly INVALID_REFERENCE_KIND: IDetailMessage = error(NS, 'INVALID_REFERENCE_KIND');
  static readonly REFERENCE_NOT_PROCESSED: IDetailMessage = error(NS, 'REFERENCE_NOT_PROCESSED');
  static readonly ALREADY_REVERSED: IDetailMessage = error(NS, 'ALREADY_REVERSED');
  static readonly AMOUNT_MISMATCH: IDetailMessage = error(NS, 'AMOUNT_MISMATCH');
  static readonly DUPLICATE_EXTERNAL_TRANSACTION: IDetailMessage = error(NS, 'DUPLICATE_EXTERNAL_TRANSACTION');
  static readonly IDEMPOTENCY_CONFLICT: IDetailMessage = error(NS, 'IDEMPOTENCY_CONFLICT');
  static readonly TRANSACTION_NOT_FOUND: IDetailMessage = error(NS, 'TRANSACTION_NOT_FOUND');
  static readonly REFERENCE_PENDING: IDetailMessage = warning(NS, 'REFERENCE_PENDING');
}
