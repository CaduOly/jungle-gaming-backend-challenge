import { describe, expect, it } from 'bun:test';
import { DEFAULT_OUTBOX_PUBLISHER_CONFIG, readOutboxPublisherConfig } from './outbox-publisher-config';

describe('readOutboxPublisherConfig', () => {
  it('falls back to the defaults', () => {
    expect(readOutboxPublisherConfig({})).toEqual(DEFAULT_OUTBOX_PUBLISHER_CONFIG);
  });

  it('reads every knob from the environment', () => {
    expect(
      readOutboxPublisherConfig({
        OUTBOX_LEASE_MS: '1500',
        OUTBOX_BATCH_SIZE: '7',
        OUTBOX_POLL_INTERVAL_MS: '25',
        OUTBOX_BACKOFF_BASE_MS: '100',
        OUTBOX_BACKOFF_CAP_MS: '2000',
        OUTBOX_MAX_ATTEMPTS: '3',
      }),
    ).toEqual({
      leaseMs: 1_500,
      batchSize: 7,
      pollIntervalMs: 25,
      backoff: { baseMs: 100, capMs: 2_000, maxAttempts: 3 },
    });
  });

  it.each([
    'OUTBOX_LEASE_MS',
    'OUTBOX_BATCH_SIZE',
    'OUTBOX_POLL_INTERVAL_MS',
    'OUTBOX_BACKOFF_BASE_MS',
    'OUTBOX_BACKOFF_CAP_MS',
    'OUTBOX_MAX_ATTEMPTS',
  ])('rejects %s=0', (name) => {
    expect(() => readOutboxPublisherConfig({ [name]: '0' })).toThrow(name);
  });

  it('rejects a non integer value', () => {
    expect(() => readOutboxPublisherConfig({ OUTBOX_LEASE_MS: '1.5' })).toThrow('OUTBOX_LEASE_MS');
  });
});
