import { NestFactory } from '@nestjs/core';
import { AppModule } from './infrastructure/framework/nest/app.module';

export const deps = [NestFactory, AppModule];
