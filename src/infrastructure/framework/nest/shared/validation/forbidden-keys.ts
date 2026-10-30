import { type DetailMessage, detail } from '../envelope/api-response';
import { ValidationDetailMessage } from '../i18n/validation.detail-message';

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Um detail por chave de prototype encontrada em qualquer lugar do body JSON parseado (o JSON.parse mantém
 * `__proto__` como chave própria). O body é recusado antes do class-transformer ou qualquer outra coisa copiar ele
 * para um objeto de verdade.
 */
export const forbiddenKeyDetails = (value: unknown, parent = ''): DetailMessage[] => {
  if (typeof value !== 'object' || value === null) return [];
  return Object.keys(value).flatMap((key) => {
    const field = parent === '' ? key : `${parent}.${key}`;
    if (FORBIDDEN_KEYS.has(key)) return [detail(ValidationDetailMessage.FORBIDDEN_KEY, field)];
    return forbiddenKeyDetails((value as Record<string, unknown>)[key], field);
  });
};
