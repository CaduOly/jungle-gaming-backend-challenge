import type { NextFunction, Request, Response } from 'express';
import { runWithLogContext } from '../../../../observability/logging/log-context';
import type { Logger } from '../../../../observability/logging/logger';
import type { AuthenticatedRequest } from '../auth/provider-auth.guard';

export const CORRELATION_ID_HEADER = 'X-Correlation-Id';

/** Qualquer outra coisa (longo demais, espaço, caractere de controle) é substituída, nunca devolvida nem logada. */
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Probes e scrapes batem em toda réplica a cada poucos segundos, então as linhas de acesso deles vão para debug. */
const QUIET_PATHS = /^\/(health|metrics)(\/|$)/;

export type CorrelatedRequest = AuthenticatedRequest & { correlationId?: string };

export const resolveCorrelationId = (received: string | undefined): string =>
  received !== undefined && VALID_CORRELATION_ID.test(received) ? received : Bun.randomUUIDv7();

/**
 * Primeiro middleware da app: pega o `X-Correlation-Id` (ou gera um), devolve ele na resposta, guarda na request
 * para os controllers (`input.correlationId`) e roda o resto da request dentro do log context.
 * Uma linha de acesso por request quando a resposta termina, o path só tem ids, nunca body.
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
