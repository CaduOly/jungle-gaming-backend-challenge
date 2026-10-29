import type { NextFunction, Request, Response } from 'express';
import { runWithLogContext } from '../../../../observability/logging/log-context';
import type { Logger } from '../../../../observability/logging/logger';
import type { AuthenticatedRequest } from '../auth/provider-auth.guard';

export const CORRELATION_ID_HEADER = 'X-Correlation-Id';

/** Anything else (too long, spaces, control characters) is replaced, never echoed back or logged. */
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Probes and scrapes hit every replica every few seconds: their access lines go to debug. */
const QUIET_PATHS = /^\/(health|metrics)(\/|$)/;

export type CorrelatedRequest = AuthenticatedRequest & { correlationId?: string };

export const resolveCorrelationId = (received: string | undefined): string =>
  received !== undefined && VALID_CORRELATION_ID.test(received) ? received : Bun.randomUUIDv7();

/**
 * First middleware of the app: takes `X-Correlation-Id` (or makes one), echoes it in the response, keeps it on the
 * request for the controllers (`input.correlationId`) and runs the rest of the request inside the log context.
 * One access line per request when the response is finished; the path has ids only, never a body.
 */
export const correlationIdMiddleware =
  (logger: Logger) =>
  (request: Request, response: Response, next: NextFunction): void => {
    const correlated = request as CorrelatedRequest;
    const correlationId = resolveCorrelationId(request.header(CORRELATION_ID_HEADER));
    correlated.correlationId = correlationId;
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    const startedAt = performance.now();
    response.on('finish', () => {
      const path = request.originalUrl.split('?')[0] ?? '';
      logger[QUIET_PATHS.test(path) ? 'debug' : 'info'](
        {
          correlationId,
          providerId: correlated.provider?.providerId,
          method: request.method,
          path,
          statusCode: response.statusCode,
          durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        },
        'http request',
      );
    });
    runWithLogContext({ correlationId }, () => next());
  };
