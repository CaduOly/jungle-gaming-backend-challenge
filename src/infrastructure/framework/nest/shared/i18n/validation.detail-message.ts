import { error, type IDetailMessage } from './detail-message';

const NS = 'VALIDATION';

/** One entry per validation rule; DTO decorators carry them in `context`. */
export class ValidationDetailMessage {
  static readonly REQUIRED: IDetailMessage = error(NS, 'REQUIRED');
  static readonly MUST_BE_STRING: IDetailMessage = error(NS, 'MUST_BE_STRING');
  static readonly MUST_BE_OBJECT: IDetailMessage = error(NS, 'MUST_BE_OBJECT');
  static readonly TOO_LONG: IDetailMessage = error(NS, 'TOO_LONG');
  static readonly BLANK: IDetailMessage = error(NS, 'BLANK');
  static readonly SURROUNDING_WHITESPACE: IDetailMessage = error(NS, 'SURROUNDING_WHITESPACE');
  static readonly NUL_CHARACTER: IDetailMessage = error(NS, 'NUL_CHARACTER');
  static readonly INVALID_UUID: IDetailMessage = error(NS, 'INVALID_UUID');
  static readonly INVALID_MONEY_AMOUNT: IDetailMessage = error(NS, 'INVALID_MONEY_AMOUNT');
  static readonly INVALID_CURRENCY: IDetailMessage = error(NS, 'INVALID_CURRENCY');
  static readonly INVALID_KIND: IDetailMessage = error(NS, 'INVALID_KIND');
  static readonly KIND_NOT_SUBMITTABLE: IDetailMessage = error(NS, 'KIND_NOT_SUBMITTABLE');
  static readonly AMOUNT_MUST_BE_POSITIVE: IDetailMessage = error(NS, 'AMOUNT_MUST_BE_POSITIVE');
  static readonly REFERENCE_REQUIRED: IDetailMessage = error(NS, 'REFERENCE_REQUIRED');
  static readonly REFERENCE_NOT_ALLOWED: IDetailMessage = error(NS, 'REFERENCE_NOT_ALLOWED');
  static readonly SELF_REFERENCE: IDetailMessage = error(NS, 'SELF_REFERENCE');
  static readonly INVALID_CURSOR: IDetailMessage = error(NS, 'INVALID_CURSOR');
  static readonly INVALID_LIMIT: IDetailMessage = error(NS, 'INVALID_LIMIT');
  static readonly IDEMPOTENCY_KEY_REQUIRED: IDetailMessage = error(NS, 'IDEMPOTENCY_KEY_REQUIRED');
  static readonly UNKNOWN_FIELD: IDetailMessage = error(NS, 'UNKNOWN_FIELD');
  static readonly MALFORMED_BODY: IDetailMessage = error(NS, 'MALFORMED_BODY');
  /** `__proto__`, `constructor` or `prototype` anywhere in the body: refused before anything reads it. */
  static readonly FORBIDDEN_KEY: IDetailMessage = error(NS, 'FORBIDDEN_KEY');
  /** A path with a broken percent-encoding, which cannot even be routed. */
  static readonly MALFORMED_PATH: IDetailMessage = error(NS, 'MALFORMED_PATH');
  static readonly PAYLOAD_TOO_LARGE: IDetailMessage = error(NS, 'PAYLOAD_TOO_LARGE');
  static readonly UNSUPPORTED_MEDIA_TYPE: IDetailMessage = error(NS, 'UNSUPPORTED_MEDIA_TYPE');
  /** Rejected by the use case itself (a rule the DTO cannot express). */
  static readonly INVALID_REQUEST: IDetailMessage = error(NS, 'INVALID_REQUEST');
}
