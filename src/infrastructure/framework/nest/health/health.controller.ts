import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import type { ReadinessProbe, ReadinessReport } from '../../../health/readiness-probe';
import { Public } from '../shared/auth/public.decorator';
import { READINESS_DETAILS, READINESS_PROBE } from '../shared/di/tokens';

/** Raw (no envelope) and open: consumed by probes. */
@ApiExcludeController()
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(READINESS_PROBE) private readonly probe: ReadinessProbe,
    @Inject(READINESS_DETAILS) private readonly details: () => Record<string, unknown>,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** 200 while every dependency answers, 503 otherwise, so the balancer stops sending traffic to this instance. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessReport & Record<string, unknown>> {
    const report = await this.probe.run();
    response.status(report.status === 'ready' ? 200 : 503);
    return { ...this.details(), ...report };
  }
}
