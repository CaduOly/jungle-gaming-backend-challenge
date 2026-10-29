import { type CallHandler, type ExecutionContext, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import { catchError, type Observable, throwError, timeout, TimeoutError } from 'rxjs';
import { TransientInfrastructureError } from '../../../../error/transient-infrastructure-error';
import { HTTP_CONFIG } from '../di/tokens';
import type { HttpConfig } from '../http-config';

/**
 * A request still running after HTTP_REQUEST_TIMEOUT_MS answers 503 + Retry-After. The work itself is not
 * cancelled: if it commits later, the provider's retry with the same Idempotency-Key gets the replay.
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
