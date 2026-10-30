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

/** Inteiro decimal não negativo vindo de texto não confiável (query string, atributo), ou undefined. */
export const parseDecimalInteger = (raw: string | undefined): number | undefined => {
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return undefined;
  return Number.parseInt(raw, 10);
};
