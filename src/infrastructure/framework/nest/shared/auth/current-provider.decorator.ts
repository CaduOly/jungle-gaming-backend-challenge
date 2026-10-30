import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedProvider } from '../../../../../business/shared/port/provider-identity.port';
import { UnauthenticatedError } from '../../../../auth/dev-provider-identity';
import type { AuthenticatedRequest } from './provider-auth.guard';

export const CurrentProvider = createParamDecorator((_data: unknown, context: ExecutionContext): AuthenticatedProvider => {
  const provider = context.switchToHttp().getRequest<AuthenticatedRequest>().provider;
  if (provider === undefined) throw new UnauthenticatedError('the route is not behind the provider guard');
  return provider;
});
