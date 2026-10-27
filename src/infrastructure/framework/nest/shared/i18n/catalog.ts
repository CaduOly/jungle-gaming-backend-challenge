import type { FailureCode } from '../../../../../business/shared/error/failure-code';
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
