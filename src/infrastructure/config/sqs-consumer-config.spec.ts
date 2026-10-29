import { describe, expect, it } from 'bun:test';
import { DEFAULT_SQS_CONSUMER_CONFIG, readSqsConsumerConfig } from './sqs-consumer-config';

describe('readSqsConsumerConfig', () => {
  it('falls back to the defaults', () => {
    expect(readSqsConsumerConfig({})).toEqual(DEFAULT_SQS_CONSUMER_CONFIG);
  });

  it('reads every knob', () => {
    expect(
      readSqsConsumerConfig({
        SQS_CONSUMER_WAIT_TIME_SECONDS: '0',
        SQS_CONSUMER_MAX_MESSAGES: '3',
        SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '2',
        SQS_CONSUMER_HEARTBEAT_INTERVAL_MS: '500',
        SQS_CONSUMER_MAX_IN_PROCESS_ATTEMPTS: '7',
        SQS_CONSUMER_RETRY_BASE_MS: '100',
        SQS_CONSUMER_RETRY_CAP_MS: '900',
        SQS_CONSUMER_ERROR_DELAY_MS: '50',
        SHUTDOWN_TIMEOUT_MS: '3000',
        SQS_CONSUMER_HANDLER_TIMEOUT_MS: '4000',
        CIRCUIT_BREAKER_FAILURE_THRESHOLD: '1',
        CIRCUIT_BREAKER_OPEN_MS: '200',
      }),
    ).toEqual({
      waitTimeSeconds: 0,
      maxMessages: 3,
      visibilityTimeoutSeconds: 2,
      heartbeatIntervalMs: 500,
      maxInProcessAttempts: 7,
      retry: { baseMs: 100, capMs: 900 },
      errorDelayMs: 50,
      shutdownTimeoutMs: 3_000,
      handlerTimeoutMs: 4_000,
      circuitBreaker: { failureThreshold: 1, openMs: 200 },
    });
  });

  it.each([
    ['SQS_CONSUMER_WAIT_TIME_SECONDS', '21'],
    ['SQS_CONSUMER_MAX_MESSAGES', '11'],
    ['SQS_CONSUMER_MAX_MESSAGES', '0'],
    ['SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS', '43201'],
    ['SHUTDOWN_TIMEOUT_MS', '0'],
    ['SQS_CONSUMER_HANDLER_TIMEOUT_MS', '0'],
    ['SQS_CONSUMER_MAX_IN_PROCESS_ATTEMPTS', '0'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => readSqsConsumerConfig({ [name]: value })).toThrow(name);
  });

  it('rejects a heartbeat that is not shorter than the visibility timeout', () => {
    expect(() =>
      readSqsConsumerConfig({ SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '2', SQS_CONSUMER_HEARTBEAT_INTERVAL_MS: '2000' }),
    ).toThrow('SQS_CONSUMER_HEARTBEAT_INTERVAL_MS');
  });
});
