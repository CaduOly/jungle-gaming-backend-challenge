import { describe, expect, it } from 'bun:test';
import { readSqsConfig } from './sqs-config';

describe('readSqsConfig', () => {
  it('defaults to the AWS endpoint, us-east-1 and the wagering-events.fifo queue name', () => {
    expect(readSqsConfig({})).toEqual({
      region: 'us-east-1',
      maxAttempts: 3,
      eventsQueue: { name: 'wagering-events.fifo' },
    });
  });

  it('reads the LocalStack endpoint, credentials and an explicit queue url', () => {
    expect(
      readSqsConfig({
        SQS_ENDPOINT: 'http://localhost:4566',
        AWS_REGION: 'sa-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'secret',
        SQS_MAX_ATTEMPTS: '1',
        SQS_EVENTS_QUEUE_URL: 'http://localhost:4566/000000000000/wagering-events-x.fifo',
        SQS_EVENTS_QUEUE_NAME: 'ignored.fifo',
      }),
    ).toEqual({
      endpoint: 'http://localhost:4566',
      region: 'sa-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'secret' },
      maxAttempts: 1,
      eventsQueue: { url: 'http://localhost:4566/000000000000/wagering-events-x.fifo' },
    });
  });

  it('reads a custom queue name', () => {
    expect(readSqsConfig({ SQS_EVENTS_QUEUE_NAME: 'events-test.fifo' }).eventsQueue).toEqual({
      name: 'events-test.fifo',
    });
  });

  it('rejects a standard (non FIFO) events queue', () => {
    expect(() => readSqsConfig({ SQS_EVENTS_QUEUE_NAME: 'wagering-events' })).toThrow('must be FIFO');
    expect(() => readSqsConfig({ SQS_EVENTS_QUEUE_URL: 'http://h/1/wagering-events' })).toThrow('must be FIFO');
  });

  it('rejects half-configured credentials', () => {
    expect(() => readSqsConfig({ AWS_ACCESS_KEY_ID: 'test' })).toThrow('must be set together');
  });

  it('rejects an endpoint that is not an http url', () => {
    expect(() => readSqsConfig({ SQS_ENDPOINT: 'localhost:4566' })).toThrow('Invalid SQS_ENDPOINT');
  });

  it('rejects SQS_MAX_ATTEMPTS=0', () => {
    expect(() => readSqsConfig({ SQS_MAX_ATTEMPTS: '0' })).toThrow('SQS_MAX_ATTEMPTS');
  });
});
