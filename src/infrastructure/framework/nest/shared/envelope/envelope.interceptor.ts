import { type CallHandler, type ExecutionContext, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';
import type { IClock } from '../../../../../business/shared/port/clock.port';
import { CLOCK } from '../di/tokens';
import { envelope } from './api-response';
import { HttpResult } from './http-result';

/**
 * Embrulha todo HttpResult no envelope e define o status. Qualquer outra coisa (health probes, /metrics, a UI do
 * Swagger) passa sem mexer, o que mantém esses endpoints crus.
 */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  constructor(@Inject(CLOCK) private readonly clock: IClock) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((value: unknown) => {
        if (!(value instanceof HttpResult)) return value;
        context.switchToHttp().getResponse<Response>().status(value.status);
        return envelope(value.status, value.data, value.details, this.clock.now());
      }),
    );
  }
}
