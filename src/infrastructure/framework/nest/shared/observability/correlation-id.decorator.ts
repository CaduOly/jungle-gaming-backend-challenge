import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { CorrelatedRequest } from './correlation-id.middleware';

/** O correlation id que o middleware resolveu para essa request, repassado ao use case como `input.correlationId`. */
export const CorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<CorrelatedRequest>().correlationId,
);
