export const readIntegerEnv = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,9}$/.test(raw)) throw new Error(`Invalid integer for ${name}: "${raw}"`);
  return Number.parseInt(raw, 10);
};

/** Non-negative integer from an external string (e.g. an SQS attribute), or undefined when it is not one. */
export const parseSafeInteger = (raw: string | undefined): number | undefined => {
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return undefined;
  return Number.parseInt(raw, 10);
};
