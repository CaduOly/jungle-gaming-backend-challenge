import { describe, expect, it } from 'bun:test';
import {
  ChangeMessageVisibilityBatchCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { DEFAULT_SQS_CONSUMER_CONFIG, type SqsConsumerConfig } from '../../config/sqs-consumer-config';
import { TransientInfrastructureError } from '../../error/transient-infrastructure-error';
import { FaultInjector } from '../../fault-injection/fault-injector';
import { type IMessageHandler, type InboundMessage, MessageOutcome } from './message-handler.port';
import { SqsConsumerLoop, VisibilityExtensionRejectedError } from './sqs-consumer-loop';

type Sent = { readonly name: string; readonly input: Record<string, unknown> };

const sqsMessage = (id: string, groupId: string, body = `{"id":"${id}"}`, receiveCount = 1): Message => ({
  MessageId: id,
  ReceiptHandle: `rh-${id}`,
  Body: body,
  Attributes: { ApproximateReceiveCount: `${receiveCount}`, MessageGroupId: groupId, SentTimestamp: '1785337200000' },
});

const stubClient = (batch: Message[], reply: (name: string) => Record<string, unknown> = () => ({})) => {
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
      return reply(command.constructor.name);
    },
  } as unknown as SQSClient;
  return { client, sent, of: (name: string) => sent.filter((entry) => entry.name === name) };
};

interface LoopOptions {
  readonly faults?: FaultInjector;
  readonly config?: Partial<SqsConsumerConfig>;
  readonly readiness?: () => Promise<void>;
  readonly onError?: (error: unknown, operation: string) => void;
}

const loopWith = (client: SQSClient, handler: IMessageHandler, options: LoopOptions = {}) =>
  new SqsConsumerLoop({
    client,
    queue: { url: 'http://sqs/q.fifo' },
    deadLetterQueue: { url: 'http://sqs/dlq.fifo' },
    handler,
    config: {
      ...DEFAULT_SQS_CONSUMER_CONFIG,
      maxInProcessAttempts: 2,
      retry: { baseMs: 4_000, capMs: 4_000 },
      errorDelayMs: 1,
      circuitBreaker: { failureThreshold: 100, openMs: 1 },
      ...options.config,
    },
    readiness: options.readiness ?? (async () => undefined),
    faults: options.faults ?? FaultInjector.none(),
    random: () => 0.5,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

const quickRetry = { retry: { baseMs: 1, capMs: 1 } };
const transient = () => new TransientInfrastructureError('lock timeout', '55P03', { cause: undefined });

const handled: InboundMessage[] = [];
const recordingHandler = (decide: (message: InboundMessage) => MessageOutcome): IMessageHandler => ({
  handle: async (message) => {
    handled.push(message);
    return decide(message);
  },
});

describe('SqsConsumerLoop (stubbed SQS)', () => {
  it('retries a failed message in the process and goes on with its group, without touching SQS visibility', async () => {
    handled.length = 0;
    const sqs = stubClient([sqsMessage('a1', 'A'), sqsMessage('a2', 'A'), sqsMessage('a3', 'A')]);
    let failures = 1;
    const loop = loopWith(
      sqs.client,
      recordingHandler((m) => (m.sqsMessageId === 'a2' && failures-- > 0 ? MessageOutcome.retry() : MessageOutcome.ack())),
      { config: quickRetry },
    );

    expect(await loop.pollOnce()).toEqual({ kind: 'received', count: 3 });

    expect(handled.map((message) => message.sqsMessageId)).toEqual(['a1', 'a2', 'a2', 'a3']);
    expect(sqs.of(DeleteMessageCommand.name).map((entry) => entry.input.ReceiptHandle)).toEqual(['rh-a1', 'rh-a2', 'rh-a3']);
    expect(sqs.of(ChangeMessageVisibilityCommand.name)).toEqual([]);
  });

  it('after the in-process ceiling hands the message back with backoff and the rest of its group with it', async () => {
    handled.length = 0;
    const sqs = stubClient([sqsMessage('a1', 'A'), sqsMessage('a2', 'A'), sqsMessage('a3', 'A'), sqsMessage('b1', 'B')]);
    const loop = loopWith(
      sqs.client,
      recordingHandler((m) => (m.sqsMessageId === 'a2' ? MessageOutcome.retry(1) : MessageOutcome.ack())),
    );

    await loop.pollOnce();

    expect(handled.map((message) => message.sqsMessageId).sort()).toEqual(['a1', 'a2', 'a2', 'b1']);
    expect(sqs.of(DeleteMessageCommand.name).map((entry) => entry.input.ReceiptHandle).sort()).toEqual(['rh-a1', 'rh-b1']);
    expect(sqs.of(ChangeMessageVisibilityCommand.name).map((entry) => [entry.input.ReceiptHandle, entry.input.VisibilityTimeout])).toEqual([
      ['rh-a2', 3],
      ['rh-a3', 3],
    ]);
  });

  it('dead-letters with retries_exhausted when the ceiling is hit on the last receive allowed', async () => {
    const sqs = stubClient([sqsMessage('x1', 'X', '{}', DEFAULT_SQS_CONSUMER_CONFIG.maxReceiveCount)]);
    const loop = loopWith(sqs.client, { handle: async () => Promise.reject(transient()) }, { config: quickRetry });

    await loop.pollOnce();

    expect(sqs.of(SendMessageCommand.name)[0]?.input).toMatchObject({
      QueueUrl: 'http://sqs/dlq.fifo',
      MessageAttributes: { 'dead-letter-reason': { DataType: 'String', StringValue: 'retries_exhausted' } },
    });
    expect(sqs.of(DeleteMessageCommand.name)).toHaveLength(1);
    expect(sqs.of(ChangeMessageVisibilityCommand.name)).toEqual([]);
  });

  it('does not count a failure as an attempt while the readiness probe fails, and feeds the breaker', async () => {
    const sqs = stubClient([sqsMessage('d1', 'D')]);
    let probes = 0;
    let calls = 0;
    const loop = loopWith(
      sqs.client,
      {
        handle: async () => {
          calls += 1;
          if (calls <= 4) throw transient();
          return MessageOutcome.ack();
        },
      },
      {
        config: quickRetry,
        readiness: async () => {
          probes += 1;
          if (probes >= 2 && probes <= 4) throw new Error('PostgreSQL is down');
        },
      },
    );

    await loop.pollOnce();

    expect(calls).toBe(5);
    expect(sqs.of(DeleteMessageCommand.name)).toHaveLength(1);
    expect(sqs.of(ChangeMessageVisibilityCommand.name)).toEqual([]);
  });

  it('reports every entry SQS refused to extend in the heartbeat', async () => {
    const sqs = stubClient([sqsMessage('h1', 'H')], (name) =>
      name === ChangeMessageVisibilityBatchCommand.name
        ? { Failed: [{ Id: '0', Code: 'ReceiptHandleIsInvalid', Message: 'gone', SenderFault: true }] }
        : {},
    );
    const errors: Array<{ error: unknown; operation: string }> = [];
    const loop = loopWith(
      sqs.client,
      {
        handle: async () => {
          await Bun.sleep(60);
          return MessageOutcome.ack();
        },
      },
      { config: { heartbeatIntervalMs: 20 }, onError: (error, operation) => errors.push({ error, operation }) },
    );

    await loop.pollOnce();

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.operation).toBe('heartbeat');
    expect(errors[0]?.error).toBeInstanceOf(VisibilityExtensionRejectedError);
    expect((errors[0]?.error as VisibilityExtensionRejectedError).sqsMessageId).toBe('h1');
  });

  it('gives each start() a fresh handler signal, so a timed-out stop does not abort the next run', async () => {
    const pending = [[sqsMessage('s1', 'S')], [sqsMessage('s2', 'S')]];
    let receives = 0;
    const client = {
      send: async (command: unknown) => {
        if (!(command instanceof ReceiveMessageCommand)) return {};
        receives += 1;
        return { Messages: receives === 1 ? pending[0] : receives === 3 ? pending[1] : [] };
      },
    } as unknown as SQSClient;
    const signals = new Map<string, AbortSignal>();
    const loop = loopWith(client, {
      handle: (message, signal) => {
        signals.set(message.sqsMessageId, signal);
        if (message.sqsMessageId === 's2') return Promise.resolve(MessageOutcome.ack());
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve(MessageOutcome.ack()), { once: true }));
      },
    }, { config: { waitTimeSeconds: 0 } });

    loop.start();
    while (!signals.has('s1')) await Bun.sleep(5);
    expect(await loop.stop(20)).toEqual({ graceful: false });
    expect(signals.get('s1')?.aborted).toBe(true);
    await Bun.sleep(20);

    loop.start();
    while (!signals.has('s2')) await Bun.sleep(5);
    expect(signals.get('s2')?.aborted).toBe(false);
    expect(await loop.stop(1_000)).toEqual({ graceful: true });
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
    const loop = loopWith(
      sqs.client,
      {
        handle: async () => {
          expect(sqs.of(DeleteMessageCommand.name)).toEqual([]);
          throw new Error('unknown');
        },
      },
      { config: { ...quickRetry, maxReceiveCount: 2 } },
    );

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
    const loop = loopWith(sqs.client, recordingHandler(() => MessageOutcome.ack()), { faults });

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
