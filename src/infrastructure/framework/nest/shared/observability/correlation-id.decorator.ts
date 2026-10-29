import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { CorrelatedRequest } from './correlation-id.middleware';

/** The correlation id the middleware resolved for this request, handed to the use case as `input.correlationId`. */
export const CorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<CorrelatedRequest>().correlationId,
);
