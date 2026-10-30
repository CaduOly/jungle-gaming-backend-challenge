import { InvalidLedgerCursorError } from '../error/invalid-ledger-cursor-error';

const PREFIX = 'seq:';
const MAX_SEQ = 9_223_372_036_854_775_807n;
const MAX_TOKEN_LENGTH = 64;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const PAYLOAD_PATTERN = /^seq:(0|[1-9]\d{0,18})$/;

/** Cursor de paginação opaco e seguro para URL: "retorna as entries com seq maior que esse". */
export class LedgerCursor {
  private constructor(readonly seq: bigint) {
    Object.freeze(this);
  }

  static afterSeq(seq: bigint): LedgerCursor {
    if (seq < 0n || seq > MAX_SEQ) throw new InvalidLedgerCursorError();
    return new LedgerCursor(seq);
  }

  static decode(token: unknown): LedgerCursor {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) throw new InvalidLedgerCursorError();
    const match = PAYLOAD_PATTERN.exec(LedgerCursor.fromBase64Url(token));
    if (match?.[1] === undefined) throw new InvalidLedgerCursorError();
    return LedgerCursor.afterSeq(BigInt(match[1]));
  }

  encode(): string {
    return btoa(`${PREFIX}${this.seq}`).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  }

  private static fromBase64Url(token: string): string {
    try {
      return atob(token.replaceAll('-', '+').replaceAll('_', '/'));
    } catch {
      throw new InvalidLedgerCursorError();
    }
  }
}
