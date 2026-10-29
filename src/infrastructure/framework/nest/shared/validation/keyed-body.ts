import { createParamDecorator, type ExecutionContext, Injectable, type PipeTransform, type Type } from '@nestjs/common';
import type { Request } from 'express';
import type { DetailMessage } from '../envelope/api-response';
import { HttpProblem } from '../errors/http-problem';
import { idempotencyKeyDetails, IDEMPOTENCY_KEY_HEADER } from './params';
import { createValidationPipe } from './validation.pipe';

export interface KeyedBody<T> {
  readonly body: T;
  readonly idempotencyKey: string;
}

interface RawKeyedBody {
  readonly body: unknown;
  readonly idempotencyKey: string | undefined;
}

/**
 * Validates the body and the Idempotency-Key header in one go, so a request missing the key and carrying an invalid
 * body hears about both. The body goes through the same pipe as every other body.
 */
@Injectable()
class KeyedBodyPipe<T extends object> implements PipeTransform<RawKeyedBody, Promise<KeyedBody<T>>> {
  constructor(private readonly metatype: Type<T>) {}

  async transform({ body, idempotencyKey }: RawKeyedBody): Promise<KeyedBody<T>> {
    const details: DetailMessage[] = [];
    let validated: unknown;
    try {
      validated = await createValidationPipe().transform(body, { type: 'body', metatype: this.metatype });
    } catch (error) {
      if (!(error instanceof HttpProblem)) throw error;
      details.push(...error.details);
    }
    details.push(...idempotencyKeyDetails(idempotencyKey));
    if (details.length > 0) throw new HttpProblem(400, details);
    return { body: validated as T, idempotencyKey: idempotencyKey as string };
  }
}

const readKeyedBody = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RawKeyedBody => {
    const request = context.switchToHttp().getRequest<Request>();
    return { body: request.body as unknown, idempotencyKey: request.header(IDEMPOTENCY_KEY_HEADER) };
  },
);

/** The request body as `metatype`, validated, with its mandatory Idempotency-Key. */
export const BodyWithIdempotencyKey = <T extends object>(metatype: Type<T>): ParameterDecorator =>
  readKeyedBody(new KeyedBodyPipe(metatype));
