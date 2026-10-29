import { Money } from '../../../../business/shared/value-object/money';

const PG_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?(?::?(\d{2}))?$/;

/**
 * timestamptz may arrive as a Date or as PostgreSQL text ("2026-07-29 15:00:00.123+00"). Infinite timestamps
 * and offsets with seconds (historical LMT zones) have no faithful JS Date, so they are rejected loudly.
 */
export const toDate = (value: unknown): Date => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('Invalid timestamp from the database: Invalid Date');
    return new Date(value.getTime());
  }
  if (value === Infinity || value === -Infinity || value === 'infinity' || value === '-infinity') {
    throw new Error(`Infinite timestamps are not supported: ${String(value)}`);
  }
  if (typeof value !== 'string') throw new Error(`Expected a timestamp, got ${typeof value}`);
  const match = PG_TIMESTAMP.exec(value);
  if (match?.[5] !== undefined && match[5] !== '00') {
    throw new Error(`Timestamp offsets with seconds are not supported: "${value}"`);
  }
  const iso = match ? `${match[1]}T${match[2]}${match[3]}:${match[4] ?? '00'}` : value;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp from the database: "${value}"`);
  return date;
};

export const toOptionalDate = (value: unknown): Date | undefined =>
  value === null || value === undefined ? undefined : toDate(value);

export const toOptionalString = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : String(value);

export const toJsonObject = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid column compared with a non-uuid text raises 22P02; such an id simply matches no row. */
export const isUuid = (value: string): boolean => UUID.test(value);

/** numeric(20,2) arrives as text ("100.00") and goes straight into Money: it never becomes a JS number. */
export const toMoney = (value: unknown, currency: string): Money => {
  if (typeof value !== 'string') throw new Error(`Expected numeric as text, got ${typeof value}`);
  return Money.from({ amount: value, currency });
};

export const toOptionalMoney = (value: unknown, currency: string): Money | undefined =>
  value === null || value === undefined ? undefined : toMoney(value, currency);

/** bigint/bigserial arrive as text; a bigint is accepted too in case a type parser is configured. */
export const toBigInt = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`Expected a bigint, got ${typeof value}`);
};

export const toText = (value: unknown, column: string): string => {
  if (typeof value !== 'string') throw new Error(`Expected text in ${column}, got ${value === null ? 'null' : typeof value}`);
  return value;
};
