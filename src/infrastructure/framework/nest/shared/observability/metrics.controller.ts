import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import type { WageringMetrics } from '../../../../observability/metrics/wagering-metrics';
import { Public } from '../auth/public.decorator';
import { METRICS } from '../di/tokens';

/** Formato texto do Prometheus, cru e aberto, com scrape em toda réplica. */
@ApiExcludeController()
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: WageringMetrics) {}

  @Get()
  async scrape(@Res() response: Response): Promise<void> {
    response.setHeader('Content-Type', this.metrics.contentType);
    response.status(200).send(await this.metrics.render());
  }
}
