import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_PENDING_REFERENCE_WORKER_CONFIG,
  readPendingReferenceWorkerConfig,
} from './pending-reference-worker-config';

const database = { lockTimeoutMs: 2_000 };

describe('readPendingReferenceWorkerConfig', () => {
  it('falls back to the defaults: base 2s, cap 60s, 8 attempts', () => {
    expect(readPendingReferenceWorkerConfig({}, database)).toEqual(DEFAULT_PENDING_REFERENCE_WORKER_CONFIG);
    expect(DEFAULT_PENDING_REFERENCE_WORKER_CONFIG.backoff).toEqual({ baseMs: 2_000, capMs: 60_000, maxAttempts: 8 });
  });

  it('reads every knob from the environment', () => {
    expect(
      readPendingReferenceWorkerConfig(
        {
          PENDING_BATCH_SIZE: '5',
          PENDING_LEASE_MS: '25000',
          PENDING_POLL_INTERVAL_MS: '50',
          PENDING_BACKOFF_BASE_MS: '100',
          PENDING_BACKOFF_CAP_MS: '400',
          PENDING_MAX_ATTEMPTS: '3',
        },
        database,
      ),
    ).toEqual({ batchSize: 5, leaseMs: 25_000, pollIntervalMs: 50, backoff: { baseMs: 100, capMs: 400, maxAttempts: 3 } });
  });

  it.each([
    'PENDING_BATCH_SIZE',
    'PENDING_LEASE_MS',
    'PENDING_POLL_INTERVAL_MS',
    'PENDING_BACKOFF_BASE_MS',
    'PENDING_BACKOFF_CAP_MS',
    'PENDING_MAX_ATTEMPTS',
  ])('rejects %s=0', (name) => {
    expect(() => readPendingReferenceWorkerConfig({ [name]: '0' }, database)).toThrow(name);
  });

  it('rejects a non integer value', () => {
    expect(() => readPendingReferenceWorkerConfig({ PENDING_BACKOFF_BASE_MS: '2s' }, database)).toThrow(
      'PENDING_BACKOFF_BASE_MS',
    );
  });

  it('rejects a cap below the base or above one day', () => {
    expect(() =>
      readPendingReferenceWorkerConfig({ PENDING_BACKOFF_BASE_MS: '5000', PENDING_BACKOFF_CAP_MS: '4999' }, database),
    ).toThrow('PENDING_BACKOFF_CAP_MS');
    expect(() => readPendingReferenceWorkerConfig({ PENDING_BACKOFF_CAP_MS: '86400001' }, database)).toThrow(
      'PENDING_BACKOFF_CAP_MS',
    );
    expect(
      readPendingReferenceWorkerConfig({ PENDING_BACKOFF_BASE_MS: '5000', PENDING_BACKOFF_CAP_MS: '5000' }, database).backoff
        .capMs,
    ).toBe(5_000);
  });

  it('requires the lease to outlive a batch where every item waits out both lock timeouts', () => {
    expect(() =>
      readPendingReferenceWorkerConfig({ PENDING_BATCH_SIZE: '5', PENDING_LEASE_MS: '20000' }, database),
    ).toThrow('must exceed PENDING_BATCH_SIZE x 2 x DB_LOCK_TIMEOUT_MS (20000ms)');
    expect(readPendingReferenceWorkerConfig({ PENDING_BATCH_SIZE: '5', PENDING_LEASE_MS: '20001' }, database).leaseMs).toBe(
      20_001,
    );
    expect(() => readPendingReferenceWorkerConfig({}, { lockTimeoutMs: 3_000 })).toThrow('PENDING_LEASE_MS');
  });
});
