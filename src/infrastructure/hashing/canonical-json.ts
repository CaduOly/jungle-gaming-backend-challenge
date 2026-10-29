const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const byCodeUnit = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * JSON with the keys of every object sorted and no whitespace, so equal data always gives the same text.
 * A property holding `undefined` is left out, exactly as JSON.stringify does: `{ a: undefined }` and `{}` are the
 * same document. Anything JSON cannot represent faithfully (bigint, non-finite numbers, functions, class
 * instances such as Date or Money) throws instead of being silently coerced into something else.
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
