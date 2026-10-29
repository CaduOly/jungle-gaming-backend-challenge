import { createRemoteJWKSet, errors, type JWTVerifyGetKey, jwtVerify } from 'jose';
import type { AuthenticatedProvider, IProviderIdentity } from '../../business/shared/port/provider-identity.port';
import { TransientInfrastructureError } from '../error/transient-infrastructure-error';
import { isValidProviderId, SYSTEM_PROVIDER } from './provider-id';
import { UnauthenticatedError } from './unauthenticated-error';

export const PROVIDER_ID_CLAIM = 'provider_id';
const ALGORITHMS = ['RS256', 'PS256', 'ES256'];
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

export interface JwksProviderIdentityOptions {
  /** Expected `iss`: the realm URL as the provider sees it, e.g. http://localhost:8081/realms/wagering. */
  readonly issuer: string;
  /** Expected `aud`: the API, which the IdP adds to every provider client's token. */
  readonly audience: string;
  /** Signing keys: the IdP's JWKS endpoint in production, a local set in the tests. */
  readonly keys: JWTVerifyGetKey;
  readonly clockToleranceSeconds?: number;
}

/**
 * The key set could not be fetched or read (timeout, connection refused, a non-200 or a broken JWKS document): the
 * IdP is down, which says nothing about the token, so it is a 503 and not a 401. A token signed by a key the set
 * does not have (JWKSNoMatchingKey) stays a 401.
 */
const isKeySetUnavailable = (error: unknown): boolean => {
  if (!(error instanceof errors.JOSEError)) return true;
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) return true;
  return error.code === 'ERR_JOSE_GENERIC' && /JSON Web Key Set/.test(error.message);
};

/**
 * Verifies a client_credentials access token from the IdP (Keycloak): signature against its JWKS, `iss`, `aud`,
 * `exp`/`nbf`, and takes the provider from the `provider_id` claim each provider client carries. Every refusal is
 * the same 401 to the caller; the reason only goes to the logs.
 */
export class JwksProviderIdentity implements IProviderIdentity {
  constructor(private readonly options: JwksProviderIdentityOptions) {}

  static remote(options: Omit<JwksProviderIdentityOptions, 'keys'> & { readonly jwksUrl: string; readonly timeoutMs?: number }) {
    const keys = createRemoteJWKSet(new URL(options.jwksUrl), { timeoutDuration: options.timeoutMs ?? 2_000 });
    return new JwksProviderIdentity({ ...options, keys });
  }

  async authenticate(credentials: string | undefined): Promise<AuthenticatedProvider> {
    if (credentials === undefined || credentials.trim() === '') throw new UnauthenticatedError('no credentials');
    const token = BEARER.exec(credentials)?.[1];
    if (token === undefined) throw new UnauthenticatedError('not a bearer JWT');
    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(token, this.options.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ALGORITHMS,
        clockTolerance: this.options.clockToleranceSeconds ?? 5,
        requiredClaims: ['exp'],
      }));
    } catch (error) {
      if (isKeySetUnavailable(error)) {
        throw new TransientInfrastructureError('The identity provider key set is unavailable', undefined, { cause: error });
      }
      throw new UnauthenticatedError(error instanceof errors.JOSEError ? error.code : 'invalid token');
    }
    const providerId = claims[PROVIDER_ID_CLAIM];
    if (!isValidProviderId(providerId)) throw new UnauthenticatedError(`missing or invalid ${PROVIDER_ID_CLAIM} claim`);
    if (providerId === SYSTEM_PROVIDER) throw new UnauthenticatedError('the system provider is internal');
    return { providerId };
  }
}
