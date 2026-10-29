import { createHash } from 'node:crypto';
import type {
  IPayloadHasher,
  WagerMessagePayload,
  WagerPayload,
} from '../../business/wagering/port/payload-hasher.port';
import { canonicalJson } from './canonical-json';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Hex sha256 of the canonical JSON. The payload arrives already normalized by the use case (Money as
 * `{ amount: "10.00", currency }`, absent reference as null), so equal requests hash equal whatever the key order.
 */
export class Sha256PayloadHasher implements IPayloadHasher {
  hash(payload: WagerPayload): string {
    return sha256(canonicalJson(payload));
  }

  hashMessage(message: WagerMessagePayload): string {
    return sha256(canonicalJson(message));
  }
}
