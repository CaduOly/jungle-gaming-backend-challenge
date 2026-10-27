import type { INestApplication, Provider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger/setup-swagger';

export interface HttpAppOptions {
  readonly persistence: Provider;
  readonly overrides?: readonly Provider[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logger?: false;
}

/** The one place that builds the HTTP app, so main.ts and the e2e suites run exactly the same wiring. */
export const createHttpApp = async (options: HttpAppOptions): Promise<INestApplication> => {
  const app = await NestFactory.create(
    AppModule.forRoot({
      persistence: options.persistence,
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
      ...(options.env === undefined ? {} : { env: options.env }),
    }),
    options.logger === false ? { logger: false } : {},
  );
  app.enableShutdownHooks();
  setupSwagger(app);
  return app;
};
