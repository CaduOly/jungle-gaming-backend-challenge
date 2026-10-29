import { describe, expect, it } from 'bun:test';
import { readHttpConfig } from './http-config';

describe('readHttpConfig', () => {
  it('defaults the body limit to 100kb', () => {
    expect(readHttpConfig({}).bodyLimit).toBe('100kb');
    expect(readHttpConfig({ HTTP_BODY_LIMIT: '' }).bodyLimit).toBe('100kb');
  });

  it.each(['512b', '64kb', '1mb', '2MB'])('reads the body limit %p', (raw) => {
    expect(readHttpConfig({ HTTP_BODY_LIMIT: raw }).bodyLimit).toBe(raw);
  });

  it.each(['0kb', '100', '1.5mb', '-1kb', '10gb', ' 1kb', 'abc'])('rejects the body limit %p', (raw) => {
    expect(() => readHttpConfig({ HTTP_BODY_LIMIT: raw })).toThrow('Invalid HTTP_BODY_LIMIT');
  });
});
