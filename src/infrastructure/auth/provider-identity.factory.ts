import type { IProviderIdentity } from '../../business/shared/port/provider-identity.port';
import type { AuthConfig } from '../config/auth-config';
import { DevProviderIdentity } from './dev-provider-identity';
import { JwksProviderIdentity } from './jwks-provider-identity';

export const createProviderIdentity = (config: AuthConfig): IProviderIdentity =>
  config.mode === 'noop'
    ? new DevProviderIdentity()
    : JwksProviderIdentity.remote({
        jwksUrl: config.jwksUrl,
        issuer: config.issuer,
        audience: config.audience,
        timeoutMs: config.timeoutMs,
      });
