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
