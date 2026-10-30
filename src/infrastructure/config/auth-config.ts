type Env = Readonly<Record<string, string | undefined>>;

export type AuthConfig =
  | { readonly mode: 'noop' }
  | {
      readonly mode: 'jwks';
      readonly jwksUrl: string;
      readonly issuer: string;
      readonly audience: string;
      readonly timeoutMs: number;
    };

export const DEFAULT_AUDIENCE = 'wagering-api';

const required = (env: Env, name: string): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`${name} is required when AUTH_MODE=jwks`);
  return value;
};

const url = (env: Env, name: string): string => {
  const value = required(env, name);
  if (!/^https?:\/\/[^/\s]+/.test(value)) throw new Error(`Invalid ${name}: "${value}" is not an http(s) URL`);
  return value;
};

/**
 * AUTH_MODE=jwks (default): token de verdade do IdP, verificado contra AUTH_JWKS_URL, AUTH_ISSUER e AUTH_AUDIENCE.
 * AUTH_MODE=noop: DevProviderIdentity, token fake que não prova nada. Só existe para dev e testes e tem que ser pedido
 * explicitamente, assim esquecer a variável nunca abre a API.
 */
export const readAuthConfig = (env: Env): AuthConfig => {
  const mode = env.AUTH_MODE?.trim() || 'jwks';
  if (mode === 'noop') return { mode };
  if (mode !== 'jwks') throw new Error(`Invalid AUTH_MODE: "${mode}" (expected noop or jwks)`);
  return {
    mode,
    jwksUrl: url(env, 'AUTH_JWKS_URL'),
    issuer: url(env, 'AUTH_ISSUER'),
    audience: env.AUTH_AUDIENCE?.trim() || DEFAULT_AUDIENCE,
    timeoutMs: 2_000,
  };
};
