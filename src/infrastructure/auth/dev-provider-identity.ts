import type { AuthenticatedProvider, IProviderIdentity } from '../../business/shared/port/provider-identity.port';

import { UnauthenticatedError } from './unauthenticated-error';
import { isValidProviderId, SYSTEM_PROVIDER } from './provider-id';

export { UnauthenticatedError } from './unauthenticated-error';

const FAKE_TOKEN = /^Bearer dev:(.+)$/;
const DEV_HEADER = /^Dev (.+)$/;

/**
 * Identidade no-op para desenvolvimento e testes, ligada só com AUTH_MODE=noop; quem verifica token de verdade é o
 * JwksProviderIdentity. Aceita `Authorization: Bearer dev:<providerId>` (token fake) ou o header de dev
 * `X-Provider-Id`, que o guard repassa como `Dev <providerId>`. Não prova nada sobre quem chamou.
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
