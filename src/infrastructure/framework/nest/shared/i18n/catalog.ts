import type { FailureCode } from '../../../../../business/shared/error/failure-code';
import type { InputRule } from '../../../../../business/shared/error/input-rule';
import type { IDetailMessage } from './detail-message';
import { InfraDetailMessage } from './infra.detail-message';
import { ValidationDetailMessage } from './validation.detail-message';
import { WageringDetailMessage } from './wagering.detail-message';
import { WalletDetailMessage } from './wallet.detail-message';

export const DETAIL_MESSAGE_CATALOGS = {
  WAGERING: WageringDetailMessage,
  WALLET: WalletDetailMessage,
  VALIDATION: ValidationDetailMessage,
  INFRA: InfraDetailMessage,
} as const;

const isDetailMessage = (value: unknown): value is IDetailMessage =>
  typeof value === 'object' && value !== null && 'code' in value && 'message' in value && 'type' in value;

/** Every entry of every catalog class, in declaration order (what GET /i18n returns). */
export const allDetailMessages = (): IDetailMessage[] =>
  Object.values(DETAIL_MESSAGE_CATALOGS).flatMap((catalog) => Object.values(catalog).filter(isDetailMessage));

const byCode = new Map(allDetailMessages().map((entry) => [entry.code, entry]));

export const findDetailMessage = (code: string): IDetailMessage | undefined => byCode.get(code);

/** The domain knows no i18n key: a FailureCode becomes its catalog entry only here, at the HTTP edge. */
export const detailForFailureCode = (code: FailureCode): IDetailMessage =>
  byCode.get(code) ?? InfraDetailMessage.INTERNAL_ERROR;

/** Every InputRule the domain can name has its message; a new rule without one does not compile. */
const INPUT_RULE_MESSAGES: Readonly<Record<InputRule, IDetailMessage>> = {
  BLANK: ValidationDetailMessage.BLANK,
  SURROUNDING_WHITESPACE: ValidationDetailMessage.SURROUNDING_WHITESPACE,
  INVALID_KIND: ValidationDetailMessage.INVALID_KIND,
  KIND_NOT_SUBMITTABLE: ValidationDetailMessage.KIND_NOT_SUBMITTABLE,
  INVALID_MONEY_AMOUNT: ValidationDetailMessage.INVALID_MONEY_AMOUNT,
  INVALID_CURRENCY: ValidationDetailMessage.INVALID_CURRENCY,
  AMOUNT_MUST_BE_POSITIVE: ValidationDetailMessage.AMOUNT_MUST_BE_POSITIVE,
  REFERENCE_REQUIRED: ValidationDetailMessage.REFERENCE_REQUIRED,
  REFERENCE_NOT_ALLOWED: ValidationDetailMessage.REFERENCE_NOT_ALLOWED,
  SELF_REFERENCE: ValidationDetailMessage.SELF_REFERENCE,
};

export const detailForInputRule = (rule: InputRule | undefined): IDetailMessage =>
  rule === undefined ? ValidationDetailMessage.INVALID_REQUEST : INPUT_RULE_MESSAGES[rule];
