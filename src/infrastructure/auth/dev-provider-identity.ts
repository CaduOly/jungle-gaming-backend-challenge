import type { AuthenticatedProvider, IProviderIdentity } from '../../business/shared/port/provider-identity.port';

import { UnauthenticatedError } from './unauthenticated-error';
import { isValidProviderId, SYSTEM_PROVIDER } from './provider-id';

export { UnauthenticatedError } from './unauthenticated-error';

const FAKE_TOKEN = /^Bearer dev:(.+)$/;
const DEV_HEADER = /^Dev (.+)$/;

/**
 * No-op identity for development and tests, the default of AUTH_MODE=noop; JwksProviderIdentity verifies real tokens.
 * Accepts `Authorization: Bearer dev:<providerId>` (a fake token) or the dev header `X-Provider-Id`,
 * which the guard forwards as `Dev <providerId>`. It proves nothing about the caller.
 */
export class DevProviderIdentity implements IProviderIdentity {
  async authenticate(credentials: string | undefined): Promise<AuthenticatedProvider> {
    if (credentials === undefined || credentials.trim() === '') throw new UnauthenticatedError('no credentials');
    const providerId = (FAKE_TOKEN.exec(credentials) ?? DEV_HEADER.exec(credentials))?.[1];
    if (providerId === undefined || !isValidProviderId(providerId)) throw new UnauthenticatedError('invalid credentials');
    if (providerId === SYSTEM_PROVIDER) throw new UnauthenticatedError('the system provider is internal');
    return { providerId };
  }
}
