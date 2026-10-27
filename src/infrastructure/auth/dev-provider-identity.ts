import type { AuthenticatedProvider, IProviderIdentity } from '../../business/shared/port/provider-identity.port';

export class UnauthenticatedError extends Error {
  constructor(reason: string) {
    super(`Unauthenticated: ${reason}`);
    this.name = 'UnauthenticatedError';
  }
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FAKE_TOKEN = /^Bearer dev:(.+)$/;
const DEV_HEADER = /^Dev (.+)$/;

/**
 * No-op identity for development and tests, until the Keycloak adapter (T14) verifies real tokens.
 * Accepts `Authorization: Bearer dev:<providerId>` (a fake token) or the dev header `X-Provider-Id`,
 * which the guard forwards as `Dev <providerId>`. It proves nothing about the caller.
 */
export class DevProviderIdentity implements IProviderIdentity {
  async authenticate(credentials: string | undefined): Promise<AuthenticatedProvider> {
    if (credentials === undefined || credentials.trim() === '') throw new UnauthenticatedError('no credentials');
    const providerId = (FAKE_TOKEN.exec(credentials) ?? DEV_HEADER.exec(credentials))?.[1];
    if (providerId === undefined || !PROVIDER_ID.test(providerId)) throw new UnauthenticatedError('invalid credentials');
    if (providerId === 'system') throw new UnauthenticatedError('the system provider is internal');
    return { providerId };
  }
}
