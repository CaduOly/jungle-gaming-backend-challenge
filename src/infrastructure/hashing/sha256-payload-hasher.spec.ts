import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { Money } from '../../business/shared/value-object/money';
import { WagerKind } from '../../business/wagering/enum/wager-kind';
import type { WagerMessagePayload, WagerPayload } from '../../business/wagering/port/payload-hasher.port';
import { FakePayloadHasher } from '../../../tests/support/fakes/fake-payload-hasher';
import { canonicalJson } from './canonical-json';
import { Sha256PayloadHasher } from './sha256-payload-hasher';

const payload: WagerPayload = {
  providerId: 'provider-1',
  externalTransactionId: 'ext-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerKind.BET,
  money: { amount: '10.00', currency: 'BRL' },
  referenceExternalTransactionId: null,
};
const message: WagerMessagePayload = { ...payload, idempotencyKey: 'key-1' };

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const reversed = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;

describe('canonicalJson', () => {
  it('sorts the keys at every level and writes no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [true, null], c: 'x' } })).toBe('{"a":{"c":"x","d":[true,null]},"b":1}');
  });

  it('sorts by code unit, so the order never depends on the locale', () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, é: 4 })).toBe('{"B":2,"a":3,"b":1,"é":4}');
  });

  it('leaves out a property holding undefined, but keeps null', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson({ a: 1, b: null })).toBe('{"a":1,"b":null}');
  });

  it('escapes strings the JSON way', () => {
    expect(canonicalJson({ 'k"': 'line\nbreak "quoted"' })).toBe('{"k\\"":"line\\nbreak \\"quoted\\""}');
  });

  it.each([
    ['a bigint', { amount: 10n }],
    ['NaN', { amount: Number.NaN }],
    ['Infinity', { amount: Number.POSITIVE_INFINITY }],
    ['a function', { fn: () => 1 }],
    ['a Date', { at: new Date(0) }],
    ['a Money instance', { money: Money.from({ amount: '1.00', currency: 'BRL' }) }],
    ['undefined at the top', undefined],
  ])('refuses %s instead of coercing it', (_, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});

describe('Sha256PayloadHasher', () => {
  const hasher = new Sha256PayloadHasher();

  it('is the hex sha256 of the canonical JSON', () => {
    expect(hasher.hash(payload)).toBe(sha256(canonicalJson(payload)));
    expect(hasher.hash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores key order, including inside money', () => {
    const shuffled = reversed({ ...payload, money: { currency: 'BRL', amount: '10.00' } });
    expect(hasher.hash(shuffled)).toBe(hasher.hash(payload));
  });

  it('hashes the normalized values: equal Money gives equal hashes, any other field changes it', () => {
    const fromMoney = (amount: string) => ({ ...payload, money: Money.from({ amount, currency: 'BRL' }).toProps() });
    expect(hasher.hash(fromMoney('10.00'))).toBe(hasher.hash(payload));
    expect(hasher.hash(fromMoney('10.01'))).not.toBe(hasher.hash(payload));
    expect(hasher.hash({ ...payload, money: { amount: '10.00', currency: 'USD' } })).not.toBe(hasher.hash(payload));
    expect(hasher.hash({ ...payload, kind: WagerKind.WIN })).not.toBe(hasher.hash(payload));
    expect(hasher.hash({ ...payload, externalTransactionId: 'ext-1 ' })).not.toBe(hasher.hash(payload));
  });

  it('treats an undefined field as absent but tells null apart from a value', () => {
    expect(hasher.hash({ ...payload, extra: undefined } as WagerPayload)).toBe(hasher.hash(payload));
    expect(hasher.hash({ ...payload, referenceExternalTransactionId: 'bet-1' })).not.toBe(hasher.hash(payload));
    const { referenceExternalTransactionId: _, ...withoutReference } = payload;
    expect(hasher.hash(withoutReference as WagerPayload)).not.toBe(hasher.hash(payload));
  });

  it('hashes a message with its idempotency key, so another key is another message', () => {
    expect(hasher.hashMessage(message)).toBe(sha256(canonicalJson(message)));
    expect(hasher.hashMessage(reversed(message))).toBe(hasher.hashMessage(message));
    expect(hasher.hashMessage({ ...message, idempotencyKey: 'key-2' })).not.toBe(hasher.hashMessage(message));
    expect(hasher.hashMessage(message)).not.toBe(hasher.hash(payload));
  });

  describe('parity with FakePayloadHasher, which returns the canonical text itself', () => {
    const fake = new FakePayloadHasher();
    const variants: Array<[string, WagerPayload]> = [
      ['the base payload', payload],
      ['a reference', { ...payload, kind: WagerKind.ROLLBACK, referenceExternalTransactionId: 'bet-1' }],
      ['reordered keys', reversed(payload)],
      ['an undefined extra field', { ...payload, extra: undefined } as WagerPayload],
      ['non-ascii text', { ...payload, gameId: 'jogo-ção-🎰' }],
    ];

    it.each(variants)('hash agrees on %s', (_, variant) => {
      expect(hasher.hash(variant)).toBe(sha256(fake.hash(variant)));
    });

    it.each(variants)('hashMessage agrees on %s', (_, variant) => {
      const withKey = { ...variant, idempotencyKey: 'key-1' };
      expect(hasher.hashMessage(withKey)).toBe(sha256(fake.hashMessage(withKey).slice('message:'.length)));
    });
  });
});
