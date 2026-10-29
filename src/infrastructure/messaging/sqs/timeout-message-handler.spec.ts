import { describe, expect, it } from 'bun:test';
import { TransientInfrastructureError } from '../../error/transient-infrastructure-error';
import { classifyMessageError } from './message-error-classifier';
import { type InboundMessage, MessageOutcome } from './message-handler.port';
import { TimeoutMessageHandler } from './timeout-message-handler';

const message: InboundMessage = { body: {}, rawBody: '{}', sqsMessageId: 'sqs-1', receiveCount: 1 };
const signal = new AbortController().signal;

describe('TimeoutMessageHandler', () => {
  it('passes the outcome of an attempt that finishes in time', async () => {
    const handler = new TimeoutMessageHandler({ handle: async () => MessageOutcome.ack() }, 50);
    expect(await handler.handle(message, signal)).toEqual({ kind: 'ack' });
  });

  it('turns an attempt that never settles into a transient failure, which the consumer retries', async () => {
    const handler = new TimeoutMessageHandler({ handle: () => new Promise<never>(() => undefined) }, 20);
    const error = await handler.handle(message, signal).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TransientInfrastructureError);
    expect(classifyMessageError(error)).toMatchObject({ outcome: { kind: 'retry' }, transient: true });
  });

  it('keeps the error of an attempt that fails in time', async () => {
    const boom = new Error('boom');
    const handler = new TimeoutMessageHandler({ handle: () => Promise.reject(boom) }, 50);
    expect(await handler.handle(message, signal).catch((reason: unknown) => reason)).toBe(boom);
  });
});
