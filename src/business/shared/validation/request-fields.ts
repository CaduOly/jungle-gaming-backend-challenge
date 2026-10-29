import { InputRule } from '../error/input-rule';
import { InvalidRequestError } from '../error/invalid-request-error';

export const MAX_TEXT_LENGTH = 255;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Surrounding whitespace is rejected, not trimmed: " tx-1" and "tx-1" would otherwise hash and store apart.
 * A NUL byte is rejected too: PostgreSQL text cannot hold it, so it would only fail later, at the write.
 */
export const requireText = (field: string, value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT_LENGTH) {
    throw new InvalidRequestError(field, `must be a non-blank string of at most ${MAX_TEXT_LENGTH} characters`, InputRule.BLANK);
  }
  if (value.trim() !== value) throw new InvalidRequestError(field, 'must not start or end with whitespace', InputRule.SURROUNDING_WHITESPACE);
  if (value.includes('\u0000')) throw new InvalidRequestError(field, 'must not contain a NUL character', InputRule.NUL_CHARACTER);
  return value;
};

/**
 * Wallet and player ids are uuid columns: anything else is refused here, before it reaches the schema. The result
 * is lower-cased, the form PostgreSQL returns, so the same id in another case hashes, compares and stores the same
 * whatever the channel (HTTP or SQS).
 */
export const requireUuid = (field: string, value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new InvalidRequestError(field, 'must be a UUID', InputRule.INVALID_UUID);
  return value.toLowerCase();
};
