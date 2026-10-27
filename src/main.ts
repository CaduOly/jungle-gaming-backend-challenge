import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { readIntegerEnv } from './infrastructure/config/integer-env';
import { AppModule } from './infrastructure/framework/nest/shared/app.module';

export const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(readIntegerEnv(process.env, 'PORT', 3000));
};

if (import.meta.main) {
  await bootstrap();
}
