import { createHash } from 'node:crypto';
import type {
  IPayloadHasher,
  WagerMessagePayload,
  WagerPayload,
} from '../../business/wagering/port/payload-hasher.port';
import { canonicalJson } from './canonical-json';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * sha256 em hex do JSON canônico. O payload já chega normalizado pelo use case (Money como
 * `{ amount: "10.00", currency }`, reference ausente como null), então requests iguais dão o mesmo hash
 * independente da ordem das chaves.
 */
export class Sha256PayloadHasher implements IPayloadHasher {
  hash(payload: WagerPayload): string {
    return sha256(canonicalJson(payload));
  }

  hashMessage(message: WagerMessagePayload): string {
    return sha256(canonicalJson(message));
  }
}
