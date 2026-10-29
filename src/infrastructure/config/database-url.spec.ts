import { describe, expect, it } from 'bun:test';
import { readDatabaseUrl } from './database-url';

describe('readDatabaseUrl', () => {
  it('uses DATABASE_URL when present', () => {
    expect(readDatabaseUrl({ DATABASE_URL: 'postgres://u:p@db:5432/app' })).toBe('postgres://u:p@db:5432/app');
  });

  it('composes the URL from the compose variables, escaping credentials', () => {
    expect(
      readDatabaseUrl({
        POSTGRES_USER: 'admin',
        POSTGRES_PASSWORD: 'p@ss:word',
        POSTGRES_HOST: 'pg',
        POSTGRES_HOST_PORT: '6543',
        POSTGRES_DB: 'wallets',
      }),
    ).toBe('postgres://admin:p%40ss%3Aword@pg:6543/wallets');
  });

  it('falls back to the local compose defaults', () => {
    expect(readDatabaseUrl({ DATABASE_URL: '' })).toBe('postgres://wagering:wagering@localhost:55432/wagering');
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => readDatabaseUrl({ DATABASE_URL: 'mysql://x' })).toThrow('Invalid DATABASE_URL');
  });
});
