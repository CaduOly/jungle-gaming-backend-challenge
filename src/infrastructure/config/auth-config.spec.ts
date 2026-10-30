import { describe, expect, it } from 'bun:test';
import { readAuthConfig } from './auth-config';

const JWKS = {
  AUTH_MODE: 'jwks',
  AUTH_JWKS_URL: 'http://keycloak:8080/realms/wagering/protocol/openid-connect/certs',
  AUTH_ISSUER: 'http://localhost:8081/realms/wagering',
};

describe('readAuthConfig', () => {
  it('defaults to JWKS, so a missing AUTH_MODE never opens the API', () => {
    const { AUTH_MODE: _, ...settings } = JWKS;
    expect(readAuthConfig(settings)).toMatchObject({ mode: 'jwks' });
    expect(readAuthConfig({ ...settings, AUTH_MODE: ' ' })).toMatchObject({ mode: 'jwks' });
    expect(() => readAuthConfig({})).toThrow('AUTH_JWKS_URL');
  });

  it('only uses the no-op identity when asked for', () => {
    expect(readAuthConfig({ AUTH_MODE: 'noop' })).toEqual({ mode: 'noop' });
  });

  it('reads the JWKS settings, with the API as the default audience', () => {
    expect(readAuthConfig(JWKS)).toEqual({
      mode: 'jwks',
      jwksUrl: JWKS.AUTH_JWKS_URL,
      issuer: JWKS.AUTH_ISSUER,
      audience: 'wagering-api',
      timeoutMs: 2_000,
    });
    expect(readAuthConfig({ ...JWKS, AUTH_AUDIENCE: 'other-api' })).toMatchObject({ audience: 'other-api' });
  });

  it.each([
    [{ AUTH_MODE: 'keycloak' }, 'AUTH_MODE'],
    [{ AUTH_MODE: 'jwks', AUTH_ISSUER: JWKS.AUTH_ISSUER }, 'AUTH_JWKS_URL'],
    [{ AUTH_MODE: 'jwks', AUTH_JWKS_URL: JWKS.AUTH_JWKS_URL }, 'AUTH_ISSUER'],
    [{ ...JWKS, AUTH_ISSUER: 'localhost/realms/wagering' }, 'AUTH_ISSUER'],
  ])('refuses %p', (env, variable) => {
    expect(() => readAuthConfig(env)).toThrow(variable);
  });
});
