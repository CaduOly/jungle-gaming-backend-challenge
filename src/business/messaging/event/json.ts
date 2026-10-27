export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Compile-time JSON check that also accepts interfaces (which have no implicit index signature).
 * Dates, bigints, functions, class instances with methods and anything with `toJSON` resolve to `never`.
 * Optional properties are allowed: JSON.stringify drops them when undefined.
 */
export type Jsonify<T> = T extends JsonPrimitive
  ? T
  : T extends Date | bigint | symbol | ((...args: never[]) => unknown)
    ? never
    : T extends readonly (infer Item)[]
      ? readonly Jsonify<Item>[]
      : T extends object
        ? { [Key in keyof T]: Jsonify<Exclude<T[Key], undefined>> }
        : never;

/** Plain JSON copy: honours `toJSON`, drops undefined, turns Dates into ISO strings. */
export const toJsonValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
