import { describe, expect, it } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { DEFAULT_SQS_CONSUMER_CONFIG } from '../../config/sqs-consumer-config';
import { FaultInjector } from '../../fault-injection/fault-injector';
import { type IMessageHandler, type InboundMessage, MessageOutcome } from './message-handler.port';
import { SqsConsumerLoop } from './sqs-consumer-loop';

type Sent = { readonly name: string; readonly input: Record<string, unknown> };

const sqsMessage = (id: string, groupId: string, body = `{"id":"${id}"}`, receiveCount = 1): Message => ({
  MessageId: id,
  ReceiptHandle: `rh-${id}`,
  Body: body,
  Attributes: { ApproximateReceiveCount: `${receiveCount}`, MessageGroupId: groupId, SentTimestamp: '1785337200000' },
});

const stubClient = (batch: Message[]) => {
  const sent: Sent[] = [];
  let delivered = false;
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command instanceof ReceiveMessageCommand) {
        if (delivered) return { Messages: [] };
        delivered = true;
        return { Messages: batch };
      }
      return {};
    },
  } as unknown as SQSClient;
  return { client, sent, of: (name: string) => sent.filter((entry) => entry.name === name) };
};

const loopWith = (client: SQSClient, handler: IMessageHandler, faults = FaultInjector.none()) =>
  new SqsConsumerLoop({
    client,
    queue: { url: 'http://sqs/q.fifo' },
    deadLetterQueue: { url: 'http://sqs/dlq.fifo' },
    handler,
    config: { ...DEFAULT_SQS_CONSUMER_CONFIG, retry: { baseMs: 4_000, capMs: 4_000 } },
    readiness: async () => undefined,
    faults,
    random: () => 0.5,
  });

const handled: InboundMessage[] = [];
const recordingHandler = (decide: (message: InboundMessage) => MessageOutcome): IMessageHandler => ({
  handle: async (message) => {
    handled.push(message);
    return decide(message);
  },
});

describe('SqsConsumerLoop (stubbed SQS)', () => {
  it('handles a group in order and hands the rest of it back when one message is retried', async () => {
    handled.length = 0;
    const sqs = stubClient([sqsMessage('a1', 'A'), sqsMessage('a2', 'A'), sqsMessage('a3', 'A'), sqsMessage('b1', 'B')]);
    const loop = loopWith(sqs.client, recordingHandler((m) => (m.sqsMessageId === 'a2' ? MessageOutcome.retry() : MessageOutcome.ack())));

    expect(await loop.pollOnce()).toEqual({ kind: 'received', count: 4 });

    expect(handled.map((message) => message.sqsMessageId).sort()).toEqual(['a1', 'a2', 'b1']);
    expect(sqs.of(DeleteMessageCommand.name).map((entry) => entry.input.ReceiptHandle).sort()).toEqual(['rh-a1', 'rh-b1']);
    expect(sqs.of(ChangeMessageVisibilityCommand.name).map((entry) => [entry.input.ReceiptHandle, entry.input.VisibilityTimeout])).toEqual([
      ['rh-a2', 3],
      ['rh-a3', 0],
    ]);
  });

  it('dead-letters invalid JSON without calling the handler, then deletes it', async () => {
    handled.length = 0;
    const sqs = stubClient([sqsMessage('p1', 'P', 'not json')]);
    const loop = loopWith(sqs.client, recordingHandler(() => MessageOutcome.ack()));

    await loop.pollOnce();

    expect(handled).toEqual([]);
    expect(sqs.sent.map((entry) => entry.name).slice(1)).toEqual([SendMessageCommand.name, DeleteMessageCommand.name]);
    expect(sqs.of(SendMessageCommand.name)[0]?.input).toMatchObject({
      QueueUrl: 'http://sqs/dlq.fifo',
      MessageBody: 'not json',
      MessageGroupId: 'P',
      MessageDeduplicationId: 'p1',
    });
  });

  it('classifies a thrown error and never deletes before the handler resolved', async () => {
    handled.length = 0;
    const sqs = stubClient([sqsMessage('e1', 'E')]);
    const loop = loopWith(sqs.client, {
      handle: async () => {
        expect(sqs.of(DeleteMessageCommand.name)).toEqual([]);
        throw new Error('unknown');
      },
    });

    await loop.pollOnce();

    expect(sqs.of(DeleteMessageCommand.name)).toEqual([]);
    expect(sqs.of(ChangeMessageVisibilityCommand.name)).toHaveLength(1);
  });

  it('crashes between the ack and the delete when crash_after_commit_before_ack is active', async () => {
    const sqs = stubClient([sqsMessage('c1', 'C')]);
    const crashes: string[] = [];
    const faults = FaultInjector.of('crash_after_commit_before_ack');
    const original = faults.crash.bind(faults);
    faults.crash = (point) => original(point, () => crashes.push(`${point}:${sqs.of(DeleteMessageCommand.name).length}`));
    const loop = loopWith(sqs.client, recordingHandler(() => MessageOutcome.ack()), faults);

    await loop.pollOnce();

    expect(crashes).toEqual(['crash_after_commit_before_ack:0']);
  });

  it('does not poll while the readiness probe fails and reports the open circuit', async () => {
    const sqs = stubClient([sqsMessage('r1', 'R')]);
    const loop = new SqsConsumerLoop({
      client: sqs.client,
      queue: { url: 'http://sqs/q.fifo' },
      deadLetterQueue: { url: 'http://sqs/dlq.fifo' },
      handler: recordingHandler(() => MessageOutcome.ack()),
      config: { ...DEFAULT_SQS_CONSUMER_CONFIG, circuitBreaker: { failureThreshold: 1, openMs: 60_000 } },
      readiness: async () => {
        throw new Error('down');
      },
    });

    expect((await loop.pollOnce()).kind).toBe('not-ready');
    expect(loop.isCircuitOpen).toBe(true);
    expect((await loop.pollOnce()).kind).toBe('paused');
    expect(sqs.sent).toEqual([]);
  });
});
