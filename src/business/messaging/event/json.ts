export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Checagem de JSON em tempo de compilação que aceita interface também, já que interface não tem index signature implícita.
 * Date, bigint, função, instância de classe com método e qualquer coisa com `toJSON` viram `never`.
 * Propriedade opcional é permitida, o JSON.stringify descarta quando vem undefined.
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

/** Cópia em JSON puro: respeita `toJSON`, descarta undefined e converte Date em string ISO. */
export const toJsonValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
