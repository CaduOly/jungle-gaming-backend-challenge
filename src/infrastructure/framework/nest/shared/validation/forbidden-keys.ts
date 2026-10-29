import { type DetailMessage, detail } from '../envelope/api-response';
import { ValidationDetailMessage } from '../i18n/validation.detail-message';

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * One detail per prototype key found anywhere in a parsed JSON body (JSON.parse keeps `__proto__` as an own
 * key). The body is refused before class-transformer or anything else copies it into a real object.
 */
export const forbiddenKeyDetails = (value: unknown, parent = ''): DetailMessage[] => {
  if (typeof value !== 'object' || value === null) return [];
  return Object.keys(value).flatMap((key) => {
    const field = parent === '' ? key : `${parent}.${key}`;
    if (FORBIDDEN_KEYS.has(key)) return [detail(ValidationDetailMessage.FORBIDDEN_KEY, field)];
    return forbiddenKeyDetails((value as Record<string, unknown>)[key], field);
  });
};
