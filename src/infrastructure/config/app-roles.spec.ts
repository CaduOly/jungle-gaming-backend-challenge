import { describe, expect, it } from 'bun:test';
import { APP_ROLES, readAppRoles, readInstanceId } from './app-roles';

describe('readAppRoles', () => {
  it.each([undefined, '', '  '])('runs every role when APP_ROLES is %p', (raw) => {
    expect([...readAppRoles({ APP_ROLES: raw })]).toEqual([...APP_ROLES]);
  });

  it('runs only the listed roles, ignoring spaces and repeats', () => {
    expect([...readAppRoles({ APP_ROLES: ' consumer, outbox ,consumer' })]).toEqual(['consumer', 'outbox']);
  });

  it.each(['api,worker', 'API', 'api,,outbox'])('refuses %p', (raw) => {
    expect(() => readAppRoles({ APP_ROLES: raw })).toThrow('Invalid APP_ROLES');
  });
});

describe('readInstanceId', () => {
  it('uses INSTANCE_ID when it is set', () => {
    expect(readInstanceId({ INSTANCE_ID: 'app-1' })).toBe('app-1');
  });

  it('falls back to host and pid', () => {
    expect(readInstanceId({}, () => 'host-42')).toBe('host-42');
    expect(readInstanceId({})).toEndWith(`-${process.pid}`);
  });

  it('refuses an id that cannot travel in a header', () => {
    expect(() => readInstanceId({ INSTANCE_ID: 'app 1' })).toThrow('Invalid INSTANCE_ID');
  });
});
