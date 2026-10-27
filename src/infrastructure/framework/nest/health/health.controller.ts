import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../shared/auth/public.decorator';

/** Raw (no envelope) and open: consumed by probes. */
@ApiExcludeController()
@Public()
@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
