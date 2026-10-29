export type LogFields = Readonly<Record<string, unknown>>;

/** One structured event per line on stdout. */
export type Log = (event: string, fields?: LogFields) => void;

const serializable = (value: unknown): unknown => (value instanceof Error ? `${value.name}: ${value.message}` : value);

/**
 * JSON lines with `time`, the fixed `base` fields (instance id, roles) and the event. Errors become their name and
 * message; the payload of a command never goes in, only ids and outcomes.
 */
export const createJsonLog =
  (base: LogFields, write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Log =>
  (event, fields = {}) => {
    const entries = Object.entries(fields).map(([key, value]) => [key, serializable(value)]);
    write(JSON.stringify({ time: new Date().toISOString(), ...base, event, ...Object.fromEntries(entries) }));
  };
