import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { JwksProviderIdentity } from '../../src/infrastructure/auth/jwks-provider-identity';
import { UnauthenticatedError } from '../../src/infrastructure/auth/unauthenticated-error';
import { client } from '../e2e/support/http-client';
import { type InMemoryHttpApp, startInMemoryHttpApp } from '../e2e/support/in-memory-http-app';

/**
 * Roda só contra o Keycloak do profile `auth` (`bun run test:auth`):
 *   docker compose up -d --wait keycloak
 * KEYCLOAK_URL tem como padrão a porta publicada desse serviço.
 */
const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8081';
const REALM_URL = `${KEYCLOAK_URL}/realms/wagering`;
const JWKS_URL = `${REALM_URL}/protocol/openid-connect/certs`;

const fetchToken = async (providerId: string, secret = `${providerId}-secret`): Promise<string> => {
  const response = await fetch(`${REALM_URL}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: providerId, client_secret: secret }),
  });
  if (!response.ok) throw new Error(`token request for ${providerId} answered ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
};

describe('Keycloak', () => {
  let http: InMemoryHttpApp;
  let call: ReturnType<typeof client>;
  const identity = JwksProviderIdentity.remote({ jwksUrl: JWKS_URL, issuer: REALM_URL, audience: 'wagering-api' });

  beforeAll(async () => {
    const discovery = await fetch(`${REALM_URL}/.well-known/openid-configuration`).catch(() => undefined);
    if (discovery?.ok !== true) {
      throw new Error(`Keycloak is not reachable at ${KEYCLOAK_URL}; start it with docker compose up first`);
    }
    http = await startInMemoryHttpApp({
      env: { AUTH_MODE: 'jwks', AUTH_JWKS_URL: JWKS_URL, AUTH_ISSUER: REALM_URL },
    });
    call = client(http.baseUrl);
  });

  afterAll(() => http?.close());

  it('maps each provider client to its own provider_id', async () => {
    expect(await identity.authenticate(`Bearer ${await fetchToken('provider-a')}`)).toEqual({ providerId: 'provider-a' });
    expect(await identity.authenticate(`Bearer ${await fetchToken('provider-b')}`)).toEqual({ providerId: 'provider-b' });
  });

  it('refuses a client with the wrong secret at the IdP', async () => {
    await expect(fetchToken('provider-a', 'wrong')).rejects.toThrow('401');
  });

  it('refuses a token whose payload was tampered with', async () => {
    const [header, payload, signature] = (await fetchToken('provider-a')).split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...claims, provider_id: 'provider-b' })).toString('base64url');
    await expect(identity.authenticate(`Bearer ${header}.${forged}.${signature}`)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('serves the API to a Keycloak token and answers 401 to the dev token', async () => {
    const token = await fetchToken('provider-a');
    const body = { playerId: Bun.randomUUIDv7(), initialBalance: { amount: '10.00', currency: 'BRL' } };

    const created = await call('POST', '/wallets', { body, provider: null, headers: { Authorization: `Bearer ${token}` } });
    const dev = await call('POST', '/wallets', { body: { ...body, playerId: Bun.randomUUIDv7() } });
    const anonymous = await call('POST', '/wallets', { body: { ...body, playerId: Bun.randomUUIDv7() }, provider: null });

    expect([created.status, dev.status, anonymous.status]).toEqual([201, 401, 401]);
  });
});
