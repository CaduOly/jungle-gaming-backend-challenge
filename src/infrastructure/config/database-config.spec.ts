import { describe, expect, it } from 'bun:test';
import { readDatabaseConfig } from './database-config';

describe('readDatabaseConfig', () => {
  it('defaults the lock timeout to 2s', () => {
    expect(readDatabaseConfig({ DATABASE_URL: 'postgres://u@h/db' })).toEqual({
      url: 'postgres://u@h/db',
      lockTimeoutMs: 2_000,
    });
  });

  it('reads DB_LOCK_TIMEOUT_MS', () => {
    expect(readDatabaseConfig({ DB_LOCK_TIMEOUT_MS: '750' }).lockTimeoutMs).toBe(750);
  });

  it.each(['0', '-1', 'abc'])('rejects DB_LOCK_TIMEOUT_MS=%p', (raw) => {
    expect(() => readDatabaseConfig({ DB_LOCK_TIMEOUT_MS: raw })).toThrow('DB_LOCK_TIMEOUT_MS');
  });
});
