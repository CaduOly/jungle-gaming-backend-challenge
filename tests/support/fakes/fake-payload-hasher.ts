import type {
  IPayloadHasher,
  WagerMessagePayload,
  WagerPayload,
} from '../../../src/business/wagering/port/payload-hasher.port';

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
};

/** Returns the canonical JSON itself (no digest), which keeps test failures readable. `undefined` counts as absent. */
export class FakePayloadHasher implements IPayloadHasher {
  hash(payload: WagerPayload): string {
    return canonical(payload);
  }

  hashMessage(message: WagerMessagePayload): string {
    return `message:${canonical(message)}`;
  }
}
