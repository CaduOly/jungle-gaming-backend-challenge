import { createRemoteJWKSet, errors, type JWTVerifyGetKey, jwtVerify } from 'jose';
import type { AuthenticatedProvider, IProviderIdentity } from '../../business/shared/port/provider-identity.port';
import { TransientInfrastructureError } from '../error/transient-infrastructure-error';
import { isValidProviderId, SYSTEM_PROVIDER } from './provider-id';
import { UnauthenticatedError } from './unauthenticated-error';

export const PROVIDER_ID_CLAIM = 'provider_id';
const ALGORITHMS = ['RS256', 'PS256', 'ES256'];
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

export interface JwksProviderIdentityOptions {
  /** `iss` esperado: a URL do realm como o provider enxerga, ex. http://localhost:8081/realms/wagering. */
  readonly issuer: string;
  /** `aud` esperado: a API, que o IdP coloca no token de todo client de provider. */
  readonly audience: string;
  /** Chaves de assinatura: o endpoint JWKS do IdP em produção, um set local nos testes. */
  readonly keys: JWTVerifyGetKey;
  readonly clockToleranceSeconds?: number;
}

/**
 * Não deu para buscar ou ler o key set (timeout, conexão recusada, resposta não 200 ou JWKS quebrado), então o IdP
 * está fora, o que não diz nada sobre o token, por isso é 503 e não 401. Token assinado por uma chave que o set não
 * tem (JWKSNoMatchingKey) continua 401.
 */
const isKeySetUnavailable = (error: unknown): boolean => {
  if (!(error instanceof errors.JOSEError)) return true;
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) return true;
  return error.code === 'ERR_JOSE_GENERIC' && /JSON Web Key Set/.test(error.message);
};

/**
 * Verifica o access token client_credentials do IdP (Keycloak): assinatura contra o JWKS, `iss`, `aud`, `exp`/`nbf`,
 * e pega o provider da claim `provider_id` que todo client de provider carrega. Toda recusa volta como o mesmo 401
 * para quem chamou, o motivo vai só para o log.
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
