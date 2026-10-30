import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { InvalidLedgerCursorError } from '../error/invalid-ledger-cursor-error';
import { LedgerCursor } from './ledger-cursor';

describe('LedgerCursor', () => {
  it.each([0n, 1n, 42n, 9_223_372_036_854_775_807n])('round-trips seq %p through an opaque token', (seq) => {
    const token = LedgerCursor.afterSeq(seq).encode();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain(seq.toString());
    expect(LedgerCursor.decode(token).seq).toBe(seq);
  });

  it.each([
    '',
    '!!!',
    'abc=',
    'a'.repeat(200),
    btoa('seq:-1'),
    btoa('seq:01'),
    btoa('seq:1.5'),
    btoa('seq:'),
    btoa('id:1'),
    btoa('seq:9223372036854775808'),
    btoa('seq:1 '),
  ])('rejects malformed token %p', (token) => {
    expect(() => LedgerCursor.decode(token)).toThrow(InvalidLedgerCursorError);
  });

  it('rejects a seq outside 0..2^63-1', () => {
    expect(() => LedgerCursor.afterSeq(-1n)).toThrow(InvalidLedgerCursorError);
    expect(() => LedgerCursor.afterSeq(9_223_372_036_854_775_808n)).toThrow(InvalidLedgerCursorError);
  });

  it.each([undefined, null, 42, 1n, {}, ['abc']])('rejects non-string token %p', (token) => {
    expect(() => LedgerCursor.decode(token)).toThrow(InvalidLedgerCursorError);
  });

  describe('token length limit', () => {
    afterEach(() => {
      atobSpy?.mockRestore();
    });
    let atobSpy: ReturnType<typeof spyOn> | undefined;

    it('decodes a token of exactly 64 characters', () => {
      atobSpy = spyOn(globalThis, 'atob');
      expect(() => LedgerCursor.decode('A'.repeat(64))).toThrow(InvalidLedgerCursorError);
      expect(atobSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects a longer token without decoding it', () => {
      atobSpy = spyOn(globalThis, 'atob');
      expect(() => LedgerCursor.decode('A'.repeat(65))).toThrow(InvalidLedgerCursorError);
      expect(atobSpy).not.toHaveBeenCalled();
    });
  });
});
