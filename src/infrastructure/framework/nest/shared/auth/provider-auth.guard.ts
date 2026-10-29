import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type {
  AuthenticatedProvider,
  IProviderIdentity,
} from '../../../../../business/shared/port/provider-identity.port';
import { bindLogContext } from '../../../../observability/logging/log-context';
import { PROVIDER_IDENTITY } from '../di/tokens';
import { IS_PUBLIC } from './public.decorator';

export type AuthenticatedRequest = Request & { provider?: AuthenticatedProvider };

export const DEV_PROVIDER_HEADER = 'X-Provider-Id';

/**
 * Global guard. Hands the Authorization header (or, in development, `X-Provider-Id` as `Dev <id>`) to
 * IProviderIdentity and keeps the authenticated provider on the request; the controllers pass it to the
 * use cases as `actor`. A failed authentication raises, and the filter answers 401.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: IProviderIdentity,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const devProvider = request.header(DEV_PROVIDER_HEADER);
    const credentials = request.header('Authorization') ?? (devProvider === undefined ? undefined : `Dev ${devProvider}`);
    request.provider = await this.identity.authenticate(credentials);
    bindLogContext({ providerId: request.provider.providerId });
    return true;
  }
}
