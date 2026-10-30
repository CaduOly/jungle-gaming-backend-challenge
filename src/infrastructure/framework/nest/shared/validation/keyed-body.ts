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
 * Valida o body e o header Idempotency-Key de uma vez, então uma request sem a key e com body inválido fica sabendo
 * dos dois. O body passa pelo mesmo pipe que todo outro body.
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

/** O body da request como `metatype`, validado, com a Idempotency-Key obrigatória. */
export const BodyWithIdempotencyKey = <T extends object>(metatype: Type<T>): ParameterDecorator =>
  readKeyedBody(new KeyedBodyPipe(metatype));
