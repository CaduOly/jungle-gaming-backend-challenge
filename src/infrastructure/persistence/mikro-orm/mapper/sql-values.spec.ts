import { describe, expect, it } from 'bun:test';
import { toDate, toJsonObject, toOptionalDate } from './sql-values';

describe('sql value mappers', () => {
  it.each([
    ['2026-07-29 15:00:00.27+00', '2026-07-29T15:00:00.270Z'],
    ['2026-07-29 15:00:00+00', '2026-07-29T15:00:00.000Z'],
    ['2026-07-29 15:00:00.123456+00', '2026-07-29T15:00:00.123Z'],
    ['2026-07-29 12:00:00.5-03', '2026-07-29T15:00:00.500Z'],
    ['2026-07-29 20:30:00+05:30', '2026-07-29T15:00:00.000Z'],
    ['2026-07-29T15:00:00.000Z', '2026-07-29T15:00:00.000Z'],
  ])('parses %p', (raw, iso) => {
    expect(toDate(raw).toISOString()).toBe(iso);
  });

  it('copies Date instances and maps null to undefined', () => {
    const date = new Date('2026-07-29T15:00:00.000Z');
    expect(toDate(date)).toEqual(date);
    expect(toDate(date)).not.toBe(date);
    expect(toOptionalDate(null)).toBeUndefined();
  });

  it.each(['infinity', '-infinity', Infinity, -Infinity])('rejects the infinite timestamp %p', (raw) => {
    expect(() => toDate(raw)).toThrow('Infinite timestamps are not supported');
  });

  it('rejects an offset with seconds instead of silently dropping them', () => {
    expect(() => toDate('1890-01-01 00:00:00-03:06:28')).toThrow('offsets with seconds are not supported');
    expect(toDate('2026-07-29 12:00:00-03:00:00').toISOString()).toBe('2026-07-29T15:00:00.000Z');
  });

  it('rejects an invalid Date instance', () => {
    expect(() => toDate(new Date('nope'))).toThrow('Invalid timestamp');
  });

  it('rejects garbage', () => {
    expect(() => toDate('yesterday')).toThrow('Invalid timestamp');
    expect(() => toDate(42)).toThrow('Expected a timestamp');
  });

  it('accepts jsonb as text or as an already parsed object', () => {
    expect(toJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(toJsonObject({ a: 1 })).toEqual({ a: 1 });
  });
});
