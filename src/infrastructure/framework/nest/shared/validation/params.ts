import { Injectable, type PipeTransform } from '@nestjs/common';
import { parseDecimalInteger } from '../../../../config/integer-env';
import { type DetailMessage, detail } from '../envelope/api-response';
import { HttpProblem } from '../errors/http-problem';
import { ValidationDetailMessage } from '../i18n/validation.detail-message';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 255;

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** Id no path que tem que ser UUID, qualquer outra coisa é 400 nesse campo antes de qualquer busca. */
@Injectable()
export class UuidParamPipe implements PipeTransform<unknown, string> {
  constructor(private readonly field: string) {}

  transform(value: unknown): string {
    if (typeof value !== 'string' || !UUID.test(value)) {
      throw new HttpProblem(400, [detail(ValidationDetailMessage.INVALID_UUID, this.field)]);
    }
    return value.toLowerCase();
  }
}

/** Segmento do path que tem que ser string não vazia com no máximo 255 caracteres. */
@Injectable()
export class TextParamPipe implements PipeTransform<unknown, string> {
  constructor(private readonly field: string) {}

  transform(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new HttpProblem(400, [detail(ValidationDetailMessage.BLANK, this.field)]);
    }
    if (value.length > MAX_TEXT_LENGTH) throw new HttpProblem(400, [detail(ValidationDetailMessage.TOO_LONG, this.field)]);
    return value;
  }
}

/** Query parameter inteiro positivo opcional dentro de [1, max]. */
@Injectable()
export class LimitQueryPipe implements PipeTransform<unknown, number | undefined> {
  constructor(private readonly max: number) {}

  transform(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    const limit = typeof value === 'string' ? parseDecimalInteger(value) : undefined;
    if (limit === undefined || limit < 1 || limit > this.max) {
      throw new HttpProblem(400, [detail(ValidationDetailMessage.INVALID_LIMIT, 'limit')]);
    }
    return limit;
  }
}

/** O header Idempotency-Key é obrigatório e é a fonte da verdade da idempotência. */
export const idempotencyKeyDetails = (value: string | undefined): DetailMessage[] => {
  if (value === undefined || value.trim() === '') {
    return [detail(ValidationDetailMessage.IDEMPOTENCY_KEY_REQUIRED, IDEMPOTENCY_KEY_HEADER)];
  }
  if (value.length > MAX_TEXT_LENGTH) return [detail(ValidationDetailMessage.TOO_LONG, IDEMPOTENCY_KEY_HEADER)];
  return [];
};
