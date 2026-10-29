import { beforeAll, describe, expect, it } from 'bun:test';
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, type JWTVerifyGetKey, SignJWT } from 'jose';
import { TransientInfrastructureError } from '../error/transient-infrastructure-error';
import { JwksProviderIdentity } from './jwks-provider-identity';
import { UnauthenticatedError } from './unauthenticated-error';

const ISSUER = 'http://localhost:8081/realms/wagering';
const AUDIENCE = 'wagering-api';
const KID = 'test-key';

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

describe('JwksProviderIdentity', () => {
  let signing: KeyPair;
  let foreign: KeyPair;
  let keys: JWTVerifyGetKey;

  const token = (
    claims: Record<string, unknown> = { provider_id: 'provider-a' },
    options: { key?: KeyPair; issuer?: string; audience?: string; expiresIn?: string | number; kid?: string } = {},
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? KID })
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '5m')
      .sign((options.key ?? signing).privateKey);

  const identity = (getKey: JWTVerifyGetKey = keys) =>
    new JwksProviderIdentity({ issuer: ISSUER, audience: AUDIENCE, keys: getKey, clockToleranceSeconds: 0 });

  beforeAll(async () => {
    signing = await generateKeyPair('RS256');
    foreign = await generateKeyPair('RS256');
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(signing.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }] });
  });

  it('reads the provider from the provider_id claim of a valid token', async () => {
    expect(await identity().authenticate(`Bearer ${await token()}`)).toEqual({ providerId: 'provider-a' });
  });

  it('takes a token with several audiences when the API is one of them', async () => {
    const jwt = await new SignJWT({ provider_id: 'provider-b' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(['account', AUDIENCE])
      .setExpirationTime('5m')
      .sign(signing.privateKey);
    expect(await identity().authenticate(`Bearer ${jwt}`)).toEqual({ providerId: 'provider-b' });
  });

  const rejected = async (credentials: string | undefined, reason: RegExp) => {
    const error = await identity()
      .authenticate(credentials)
      .then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(UnauthenticatedError);
    expect((error as Error).message).toMatch(reason);
  };

  it('rejects an expired token', async () => {
    await rejected(`Bearer ${await token(undefined, { expiresIn: Math.floor(Date.now() / 1000) - 60 })}`, /ERR_JWT_EXPIRED/);
  });

  it('rejects a token signed by another key under the same kid', async () => {
    await rejected(`Bearer ${await token(undefined, { key: foreign })}`, /ERR_JWS_SIGNATURE_VERIFICATION_FAILED/);
  });

  it('rejects a token signed by a key the set does not have', async () => {
    await rejected(`Bearer ${await token(undefined, { key: foreign, kid: 'unknown' })}`, /ERR_JWKS_NO_MATCHING_KEY/);
  });

  it('rejects a token without provider_id', async () => {
    await rejected(`Bearer ${await token({ sub: 'service-account-provider-a' })}`, /provider_id/);
  });

  it.each([['Provider A'], [''], [42], ['system']])('rejects the provider_id %p', async (providerId) => {
    await rejected(`Bearer ${await token({ provider_id: providerId })}`, /provider_id|system/);
  });

  it('rejects a token for another audience', async () => {
    await rejected(`Bearer ${await token(undefined, { audience: 'account' })}`, /ERR_JWT_CLAIM_VALIDATION_FAILED/);
  });

  it('rejects a token from another issuer', async () => {
    await rejected(`Bearer ${await token(undefined, { issuer: 'http://evil/realms/wagering' })}`, /ERR_JWT_CLAIM_VALIDATION_FAILED/);
  });

  it('rejects an unsigned token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ provider_id: 'provider-a', iss: ISSUER, aud: AUDIENCE })).toString('base64url');
    await rejected(`Bearer ${header}.${body}.`, /bearer JWT/);
    await rejected(`Bearer ${header}.${body}.c2ln`, /ERR_JOSE_ALG_NOT_ALLOWED|ERR_JWS_INVALID/);
  });

  it.each([[undefined], [''], ['Basic dXNlcg=='], ['Bearer dev:provider-a'], ['Dev provider-a']])(
    'rejects the credentials %p',
    async (credentials) => {
      await rejected(credentials, /no credentials|bearer JWT/);
    },
  );

  it('answers a transient failure, not a 401, when the key set cannot be fetched', async () => {
    const unreachable: JWTVerifyGetKey = () => Promise.reject(new errors.JWKSTimeout());
    const down: JWTVerifyGetKey = () => Promise.reject(new TypeError('fetch failed'));
    const jwt = await token();

    await expect(identity(unreachable).authenticate(`Bearer ${jwt}`)).rejects.toBeInstanceOf(TransientInfrastructureError);
    await expect(identity(down).authenticate(`Bearer ${jwt}`)).rejects.toBeInstanceOf(TransientInfrastructureError);
  });
});
