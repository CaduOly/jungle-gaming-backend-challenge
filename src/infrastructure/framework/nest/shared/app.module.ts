import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import type { IReadinessCheck } from '../../../health/readiness-check.port';
import { HealthModule } from '../health/health.module';
import { I18nController } from '../i18n/i18n.controller';
import { WageringController } from '../wagering/wagering.controller';
import { WalletController } from '../wallet/wallet.controller';
import { ProviderAuthGuard } from './auth/provider-auth.guard';
import { coreProviders } from './di/core.providers';
import { useCaseProviders } from './di/use-case.providers';
import { EnvelopeInterceptor } from './envelope/envelope.interceptor';
import { HttpExceptionFilter } from './errors/http-exception.filter';
import { readHttpConfig } from './http-config';
import { JsonContentTypeGuard } from './http/json-content-type.guard';
import { createValidationPipe } from './validation/validation.pipe';

export interface AppModuleOptions {
  /** Binds WAGERING_PERSISTENCE: the in-memory fakes in the e2e suites, PostgreSQL once T07b lands. */
  readonly persistence: Provider;
  /** Replaces any core provider (clock, ids, identity…) by token; used by the tests. */
  readonly overrides?: readonly Provider[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** What /health/ready checks: PostgreSQL and SQS in production, nothing over the in-memory fakes. */
  readonly readinessChecks?: readonly IReadinessCheck[];
}

@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const env = options.env ?? process.env;
    return {
      module: AppModule,
      imports: [HealthModule.forRoot(options.readinessChecks ?? [], readHttpConfig(env).readinessTimeoutMs)],
      controllers: [WalletController, WageringController, I18nController],
      providers: [
        ...coreProviders(env),
        ...(options.overrides ?? []),
        options.persistence,
        ...useCaseProviders,
        { provide: APP_GUARD, useClass: ProviderAuthGuard },
        { provide: APP_GUARD, useClass: JsonContentTypeGuard },
        { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        { provide: APP_PIPE, useFactory: createValidationPipe },
      ],
    };
  }
}
