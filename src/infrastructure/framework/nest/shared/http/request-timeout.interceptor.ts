import { type CallHandler, type ExecutionContext, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import { catchError, type Observable, throwError, timeout, TimeoutError } from 'rxjs';
import { TransientInfrastructureError } from '../../../../error/transient-infrastructure-error';
import { HTTP_CONFIG } from '../di/tokens';
import type { HttpConfig } from '../http-config';

/**
 * Request que ainda está rodando depois de HTTP_REQUEST_TIMEOUT_MS responde 503 + Retry-After. O trabalho em si não
 * é cancelado, se ele commitar depois o retry do provider com a mesma Idempotency-Key recebe o replay.
 */
@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  constructor(@Inject(HTTP_CONFIG) private readonly config: HttpConfig) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(this.config.requestTimeoutMs),
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof TimeoutError
            ? new TransientInfrastructureError(`Request exceeded ${this.config.requestTimeoutMs}ms`, undefined, { cause: error })
            : error,
        ),
      ),
    );
  }
}
