import { createParamDecorator, type ExecutionContext, Injectable, type PipeTransform } from '@nestjs/common';
import type { Request } from 'express';
import { parseDecimalInteger } from '../../../../config/integer-env';
import { detail } from '../envelope/api-response';
import { HttpProblem } from '../errors/http-problem';
import { ValidationDetailMessage } from '../i18n/validation.detail-message';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 255;

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** A path id that must be a UUID; anything else is a 400 on that field, before any lookup. */
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

/** A path segment that must be a non-blank string of at most 255 characters. */
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

/** Optional positive integer query parameter within [1, max]. */
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

/** The Idempotency-Key header is mandatory and is the source of truth for idempotency. */
export const IdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const value = context.switchToHttp().getRequest<Request>().header(IDEMPOTENCY_KEY_HEADER);
  if (value === undefined || value.trim() === '') {
    throw new HttpProblem(400, [detail(ValidationDetailMessage.IDEMPOTENCY_KEY_REQUIRED, IDEMPOTENCY_KEY_HEADER)]);
  }
  if (value.length > MAX_TEXT_LENGTH) {
    throw new HttpProblem(400, [detail(ValidationDetailMessage.TOO_LONG, IDEMPOTENCY_KEY_HEADER)]);
  }
  return value;
});
