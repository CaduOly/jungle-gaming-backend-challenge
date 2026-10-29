import type { INestApplication, Provider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createObservability, type Observability } from '../../../observability/observability';
import { AppModule, type AppModuleOptions } from './app.module';
import { readHttpConfig } from './http-config';
import { correlationIdMiddleware } from './observability/correlation-id.middleware';
import { PinoNestLogger } from './observability/pino-nest-logger';
import { setupSwagger } from './swagger/setup-swagger';

export interface HttpAppOptions {
  readonly persistence: Provider;
  readonly overrides?: readonly Provider[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Silences every log line (Nest's and the app's); ignored when `observability` is given. */
  readonly logger?: false;
  /** Logger and metrics to use; built from the env (LOG_LEVEL) when omitted. */
  readonly observability?: Observability;
  readonly readinessChecks?: AppModuleOptions['readinessChecks'];
  readonly readinessDetails?: AppModuleOptions['readinessDetails'];
  /** Sent as X-Instance-Id on every answer, so a caller behind the balancer knows which replica served it. */
  readonly instanceId?: string;
  /**
   * Nest's own SIGTERM hooks (default). The process entry point turns them off: it owns the signals and closes
   * the HTTP server together with the workers and the ORM.
   */
  readonly shutdownHooks?: boolean;
}

/**
 * The one place that builds the HTTP app, so main.ts and the e2e suites run exactly the same wiring. Only
 * `application/json` bodies are parsed, the same media type the JsonContentTypeGuard lets through. The correlation
 * id middleware comes first, so even a 413 or a malformed body answers with `X-Correlation-Id`.
 */
export const createHttpApp = async (options: HttpAppOptions): Promise<INestApplication> => {
  const env = options.env ?? process.env;
  const observability =
    options.observability ?? createObservability({ env, ...(options.logger === false ? { level: 'silent' } : {}) });
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({
      persistence: options.persistence,
      observability,
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.readinessChecks === undefined ? {} : { readinessChecks: options.readinessChecks }),
      ...(options.readinessDetails === undefined ? {} : { readinessDetails: options.readinessDetails }),
    }),
    { bodyParser: false, logger: new PinoNestLogger(observability.logger) },
  );
  app.use(correlationIdMiddleware(observability.logger));
  const { instanceId } = options;
  if (instanceId !== undefined) {
    app.use((_request: unknown, response: { setHeader(name: string, value: string): void }, next: () => void) => {
      response.setHeader('X-Instance-Id', instanceId);
      next();
    });
  }
  app.useBodyParser('json', { type: 'application/json', limit: readHttpConfig(env).bodyLimit });
  if (options.shutdownHooks !== false) app.enableShutdownHooks();
  setupSwagger(app);
  return app;
};
