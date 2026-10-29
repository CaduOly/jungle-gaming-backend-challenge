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
    }),
    { bodyParser: false, ...(options.logger === false ? { logger: false as const } : {}) },
  );
  app.useBodyParser('json', { type: 'application/json', limit: readHttpConfig(options.env ?? process.env).bodyLimit });
  app.enableShutdownHooks();
  setupSwagger(app);
  return app;
};
