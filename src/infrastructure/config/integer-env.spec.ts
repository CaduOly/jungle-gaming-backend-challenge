import { describe, expect, it } from 'bun:test';
import { readIntegerEnv } from './integer-env';

describe('readIntegerEnv', () => {
  it('returns the fallback when the variable is missing or empty', () => {
    expect(readIntegerEnv({}, 'PORT', 3000)).toBe(3000);
    expect(readIntegerEnv({ PORT: '' }, 'PORT', 3000)).toBe(3000);
  });

  it('parses a plain non-negative integer', () => {
    expect(readIntegerEnv({ PORT: '8080' }, 'PORT', 3000)).toBe(8080);
  });

  it.each(['-1', '1.5', '1e3', ' 80', '0x10', 'abc', '1234567890'])('rejects %p', (raw) => {
    expect(() => readIntegerEnv({ PORT: raw }, 'PORT', 3000)).toThrow('Invalid integer for PORT');
  });
});
