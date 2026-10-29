import type { LoggerService } from '@nestjs/common';
import type { Logger } from '../../../../observability/logging/logger';

const contextOf = (params: unknown[]): string | undefined => {
  const last = params.at(-1);
  return typeof last === 'string' ? last : undefined;
};

const text = (message: unknown): string => (typeof message === 'string' ? message : JSON.stringify(message));

/** Nest's own lines (bootstrap, routes, the filter's 500s) in the same JSON stream as the rest. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.logger.info({ context: contextOf(params) }, text(message));
  }

  error(message: unknown, ...params: unknown[]): void {
    this.logger.error({ context: contextOf(params) }, text(message));
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.logger.warn({ context: contextOf(params) }, text(message));
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.logger.debug({ context: contextOf(params) }, text(message));
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.logger.trace({ context: contextOf(params) }, text(message));
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.logger.fatal({ context: contextOf(params) }, text(message));
  }
}
