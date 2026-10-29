import type { INestApplication, Provider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule, type AppModuleOptions } from './app.module';
import { readHttpConfig } from './http-config';
import { setupSwagger } from './swagger/setup-swagger';

export interface HttpAppOptions {
  readonly persistence: Provider;
  readonly overrides?: readonly Provider[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logger?: false;
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
 * `application/json` bodies are parsed, the same media type the JsonContentTypeGuard lets through.
 */
export const createHttpApp = async (options: HttpAppOptions): Promise<INestApplication> => {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({
      persistence: options.persistence,
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.readinessChecks === undefined ? {} : { readinessChecks: options.readinessChecks }),
      ...(options.readinessDetails === undefined ? {} : { readinessDetails: options.readinessDetails }),
    }),
    { bodyParser: false, ...(options.logger === false ? { logger: false as const } : {}) },
  );
  const { instanceId } = options;
  if (instanceId !== undefined) {
    app.use((_request: unknown, response: { setHeader(name: string, value: string): void }, next: () => void) => {
      response.setHeader('X-Instance-Id', instanceId);
      next();
    });
  }
  app.useBodyParser('json', { type: 'application/json', limit: readHttpConfig(options.env ?? process.env).bodyLimit });
  if (options.shutdownHooks !== false) app.enableShutdownHooks();
  setupSwagger(app);
  return app;
};
