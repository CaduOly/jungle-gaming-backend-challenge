import { createHash } from 'node:crypto';
import type {
  IPayloadHasher,
  WagerMessagePayload,
  WagerPayload,
} from '../../business/wagering/port/payload-hasher.port';

/**
 * Canonical JSON: object keys sorted by code unit at every level, no whitespace, arrays kept in order,
 * strings and numbers as JSON.stringify writes them. Two requests are "the same" exactly when their
 * normalized fields serialize to the same text; the sha256 of that text (hex) is what gets stored.
 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
};

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export class Sha256PayloadHasher implements IPayloadHasher {
  hash(payload: WagerPayload): string {
    return sha256(canonicalJson(payload));
  }

  hashMessage(message: WagerMessagePayload): string {
    return sha256(canonicalJson(message));
  }
}
