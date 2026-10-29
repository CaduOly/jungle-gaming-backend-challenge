import { describe, expect, it } from 'bun:test';
import { FaultInjector } from '../../fault-injection/fault-injector';
import { FaultInjectingMessageHandler } from './fault-injecting-message-handler';
import { type IMessageHandler, type InboundMessage, MessageOutcome } from './message-handler.port';

const message: InboundMessage = { body: {}, rawBody: '{}', sqsMessageId: 'm-1', receiveCount: 1 };
const inner: IMessageHandler = { handle: async () => MessageOutcome.ack() };

describe('FaultInjectingMessageHandler', () => {
  it('holds the message for slowHandlerMs when slow_handler is active', async () => {
    const handler = new FaultInjectingMessageHandler(inner, FaultInjector.of('slow_handler').withSlowHandlerMs(40));
    const startedAt = performance.now();
    expect(await handler.handle(message, new AbortController().signal)).toEqual({ kind: 'ack' });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(35);
  });

  it('delegates right away otherwise', async () => {
    const handler = new FaultInjectingMessageHandler(inner, FaultInjector.none());
    const startedAt = performance.now();
    await handler.handle(message, new AbortController().signal);
    expect(performance.now() - startedAt).toBeLessThan(20);
  });
});
