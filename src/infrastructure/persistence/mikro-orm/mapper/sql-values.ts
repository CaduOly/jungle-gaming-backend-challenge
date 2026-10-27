const PG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/;

/** timestamptz may arrive as a Date or as PostgreSQL text ("2026-07-29 15:00:00.123+00"). */
export const toDate = (value: unknown): Date => {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value !== 'string') throw new Error(`Expected a timestamp, got ${typeof value}`);
  const match = PG_TIMESTAMP.exec(value);
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
