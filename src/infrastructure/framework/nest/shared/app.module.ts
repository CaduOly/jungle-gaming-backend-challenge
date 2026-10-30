import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import type { IReadinessCheck } from '../../../health/readiness-check.port';
import type { Observability } from '../../../observability/observability';
import { HealthModule } from '../health/health.module';
import { I18nController } from '../i18n/i18n.controller';
import { WageringController } from '../wagering/wagering.controller';
import { WalletController } from '../wallet/wallet.controller';
import { ProviderAuthGuard } from './auth/provider-auth.guard';
import { coreProviders } from './di/core.providers';
import { LOGGER, METRICS } from './di/tokens';
import { useCaseProviders } from './di/use-case.providers';
import { EnvelopeInterceptor } from './envelope/envelope.interceptor';
import { HttpExceptionFilter } from './errors/http-exception.filter';
import { readHttpConfig } from './http-config';
import { MetricsController } from './observability/metrics.controller';
import { RequestTimeoutInterceptor } from './http/request-timeout.interceptor';
import { createValidationPipe } from './validation/validation.pipe';

export interface AppModuleOptions {
  /** Faz o bind de WAGERING_PERSISTENCE: fakes in-memory nas suites e2e, PostgreSQL na app rodando. */
  readonly persistence: Provider;
  /** Substitui qualquer provider do core (clock, ids, identity…) pelo token, usado pelos testes. */
  readonly overrides?: readonly Provider[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** O que o /health/ready checa: PostgreSQL e SQS em produção, nada em cima dos fakes in-memory. */
  readonly readinessChecks?: readonly IReadinessCheck[];
  /** Logger e registry de métricas do processo, montados uma vez pelo createHttpApp e compartilhados com os workers. */
  readonly observability: Observability;
  /** Vai junto no body do /health/ready: instance id, roles e estado do breaker do processo rodando. */
  readonly readinessDetails?: () => Record<string, unknown>;
}

@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const env = options.env ?? process.env;
    return {
      module: AppModule,
      imports: [
        HealthModule.forRoot(
          options.readinessChecks ?? [],
          readHttpConfig(env).readinessTimeoutMs,
          options.readinessDetails ?? (() => ({})),
        ),
      ],
      controllers: [WalletController, WageringController, I18nController, MetricsController],
      providers: [
        { provide: LOGGER, useValue: options.observability.logger },
        { provide: METRICS, useValue: options.observability.metrics },
        ...coreProviders(env),
        ...(options.overrides ?? []),
        options.persistence,
        ...useCaseProviders,
        { provide: APP_GUARD, useClass: ProviderAuthGuard },
        { provide: APP_INTERCEPTOR, useClass: RequestTimeoutInterceptor },
        { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        { provide: APP_PIPE, useFactory: createValidationPipe },
      ],
    };
  }
}
