const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const byCodeUnit = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * JSON com as chaves de todo objeto ordenadas e sem espaço, então dado igual sempre gera o mesmo texto.
 * Propriedade com `undefined` fica de fora, exatamente como o JSON.stringify faz: `{ a: undefined }` e `{}` são o
 * mesmo documento. Qualquer coisa que o JSON não representa fielmente (bigint, número não finito, função, instância
 * de classe como Date ou Money) lança erro em vez de ser convertida em silêncio para outra coisa.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`Cannot hash the non-finite number ${value}`);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`Cannot hash a value of type ${typeof value}`);
  }
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  if (!isPlainObject(value)) throw new TypeError('Cannot hash a class instance; pass its plain props');
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(byCodeUnit);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
};
