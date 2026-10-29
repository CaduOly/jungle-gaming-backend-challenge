import { describe, expect, it } from 'bun:test';
import { UuidV7IdGenerator } from './uuid-v7-id-generator';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('UuidV7IdGenerator', () => {
  it('generates distinct UUIDv7 ids in ascending order', () => {
    const generator = new UuidV7IdGenerator();
    const ids = Array.from({ length: 1_000 }, () => generator.generate());

    expect(ids.every((id) => UUID_V7.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});
