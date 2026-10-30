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
  /** Silencia todas as linhas de log (do Nest e da app), ignorado quando `observability` é passado. */
  readonly logger?: false;
  /** Logger e métricas a usar, montados a partir do env (LOG_LEVEL) quando omitidos. */
  readonly observability?: Observability;
  readonly readinessChecks?: AppModuleOptions['readinessChecks'];
  readonly readinessDetails?: AppModuleOptions['readinessDetails'];
  /** Vai como X-Instance-Id em toda resposta, assim quem chama por trás do balancer sabe qual réplica atendeu. */
  readonly instanceId?: string;
  /**
   * Hooks de SIGTERM do próprio Nest (default). O entry point do processo desliga eles, já que os sinais são dele e
   * ele fecha o servidor HTTP junto com os workers e o ORM.
   */
  readonly shutdownHooks?: boolean;
}

/**
 * Único lugar que monta a app HTTP, então o main.ts e as suites e2e rodam exatamente o mesmo wiring. Só body
 * `application/json` é parseado, o mesmo media type que o JsonContentTypeGuard deixa passar. O middleware de
 * correlation id vem primeiro, então até um 413 ou um body malformado responde com `X-Correlation-Id`.
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
