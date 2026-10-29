import { type ArgumentsHost, Catch, type ExceptionFilter, Inject, Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { IClock } from '../../../../../business/shared/port/clock.port';
import { CLOCK, HTTP_CONFIG } from '../di/tokens';
import { envelope } from '../envelope/api-response';
import type { HttpConfig } from '../http-config';
import { toHttpProblem } from './to-http-problem';

/** Every error, from any route, leaves in the envelope. A 500 is logged with its stack but never exposes it. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(
    @Inject(CLOCK) private readonly clock: IClock,
    @Inject(HTTP_CONFIG) private readonly config: HttpConfig,
  ) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const problem = toHttpProblem(error, { retryAfterSeconds: this.config.retryAfterSeconds });
    if (problem.status >= 500 && problem.status !== 503) {
      this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    const response = host.switchToHttp().getResponse<Response>();
    for (const [name, value] of Object.entries(problem.headers)) response.setHeader(name, value);
    response.status(problem.status).json(envelope(problem.status, problem.data, problem.details, this.clock.now()));
  }
}
