import { describe, expect, it } from 'bun:test';
import { DEFAULT_PENDING_REFERENCE_BACKOFF, readPendingReferenceBackoff } from './pending-reference-config';

describe('readPendingReferenceBackoff', () => {
  it('falls back to the defaults and reads every knob', () => {
    expect(readPendingReferenceBackoff({})).toEqual(DEFAULT_PENDING_REFERENCE_BACKOFF);
    expect(
      readPendingReferenceBackoff({
        PENDING_REFERENCE_BACKOFF_BASE_MS: '100',
        PENDING_REFERENCE_BACKOFF_CAP_MS: '900',
        PENDING_REFERENCE_MAX_ATTEMPTS: '3',
      }),
    ).toEqual({ baseMs: 100, capMs: 900, maxAttempts: 3 });
  });

  it.each(['PENDING_REFERENCE_BACKOFF_BASE_MS', 'PENDING_REFERENCE_BACKOFF_CAP_MS', 'PENDING_REFERENCE_MAX_ATTEMPTS'])(
    'rejects %s=0',
    (name) => {
      expect(() => readPendingReferenceBackoff({ [name]: '0' })).toThrow(name);
    },
  );
});
