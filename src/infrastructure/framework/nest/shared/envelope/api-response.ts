import type { IDetailMessage } from '../i18n/detail-message';
import { codeName } from './status-code';

export interface DetailMessage extends IDetailMessage {
  /** Caminho com ponto do campo com problema (`money.amount`), quando o problema é de um campo. */
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
