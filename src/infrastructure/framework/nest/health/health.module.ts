import { type DynamicModule, Module } from '@nestjs/common';
import type { IReadinessCheck } from '../../../health/readiness-check.port';
import { ReadinessProbe } from '../../../health/readiness-probe';
import { READINESS_DETAILS, READINESS_PROBE } from '../shared/di/tokens';
import { HealthController } from './health.controller';

@Module({})
export class HealthModule {
  static forRoot(
    checks: readonly IReadinessCheck[],
    timeoutMs: number,
    details: () => Record<string, unknown> = () => ({}),
  ): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [
        { provide: READINESS_PROBE, useValue: new ReadinessProbe(checks, timeoutMs) },
        { provide: READINESS_DETAILS, useValue: details },
      ],
    };
  }
}
