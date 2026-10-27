import { describe, expect, it } from 'bun:test';
import type { WagerPayload } from '../../business/wagering/port/payload-hasher.port';
import { canonicalJson, Sha256PayloadHasher } from './sha256-payload-hasher';

const payload: WagerPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  playerId: 'p',
  walletId: 'w',
  roundId: 'r',
  gameId: 'g',
  kind: 'BET' as WagerPayload['kind'],
  money: { amount: '25.00', currency: 'BRL' },
  referenceExternalTransactionId: null,
};

describe('canonicalJson', () => {
  it('sorts keys at every level and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it('skips undefined fields but keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe('Sha256PayloadHasher', () => {
  const hasher = new Sha256PayloadHasher();

  it('is independent of key order and is a sha256 hex digest', () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as unknown as WagerPayload;
    expect(hasher.hash(reordered)).toBe(hasher.hash(payload));
    expect(hasher.hash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with any business field', () => {
    expect(hasher.hash({ ...payload, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(hasher.hash(payload));
  });

  it('hashes the message (with its key) apart from the payload', () => {
    expect(hasher.hashMessage({ ...payload, idempotencyKey: 'k' })).not.toBe(hasher.hash(payload));
  });
});
