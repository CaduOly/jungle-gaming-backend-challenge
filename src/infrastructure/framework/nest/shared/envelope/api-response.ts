import type { IDetailMessage } from '../i18n/detail-message';
import { codeName } from './status-code';

export interface DetailMessage extends IDetailMessage {
  /** Dotted path of the offending field (`money.amount`), when the problem is about one. */
  readonly field?: string;
}

export interface ApiResponseEnvelope<T> {
  readonly code: number;
  readonly message: string;
  readonly data: T | null;
  readonly timestamp: number;
  readonly detailsMessage: readonly DetailMessage[];
}

export const detail = (message: IDetailMessage, field?: string): DetailMessage =>
  field === undefined ? { ...message } : { ...message, field };

export const envelope = <T>(
  status: number,
  data: T | null,
  details: readonly DetailMessage[],
  now: Date,
): ApiResponseEnvelope<T> => ({
  code: status,
  message: codeName(status),
  data,
  timestamp: now.getTime(),
  detailsMessage: details,
});
