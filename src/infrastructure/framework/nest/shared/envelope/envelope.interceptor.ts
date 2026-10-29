import { type CallHandler, type ExecutionContext, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';
import type { IClock } from '../../../../../business/shared/port/clock.port';
import { CLOCK } from '../di/tokens';
import { envelope } from './api-response';
import { HttpResult } from './http-result';

/**
 * Wraps every HttpResult in the envelope and sets its status. Anything else (health probes, /metrics, the
 * Swagger UI) passes through untouched, which keeps those endpoints raw.
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
