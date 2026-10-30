import { describe, expect, it } from 'bun:test';
import { DevProviderIdentity, UnauthenticatedError } from './dev-provider-identity';

describe('DevProviderIdentity', () => {
  const identity = new DevProviderIdentity();

  it.each([
    ['Bearer dev:provider-a', 'provider-a'],
    ['Dev provider-b', 'provider-b'],
  ])('reads the provider from %p', async (credentials, providerId) => {
    expect(await identity.authenticate(credentials)).toEqual({ providerId });
  });

  it.each([undefined, '', 'Bearer abc', 'Bearer dev:', 'Bearer dev:Provider A', 'Basic dXNlcg==', 'Bearer dev:system'])(
    'rejects %p',
    async (credentials) => {
      await expect(identity.authenticate(credentials)).rejects.toBeInstanceOf(UnauthenticatedError);
    },
  );
});
