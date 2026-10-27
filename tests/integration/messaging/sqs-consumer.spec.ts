import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { DEFAULT_SQS_CONSUMER_CONFIG, type SqsConsumerConfig } from '../../../src/infrastructure/config/sqs-consumer-config';
import { TransientInfrastructureError } from '../../../src/infrastructure/error/transient-infrastructure-error';
import { InvalidMessageError } from '../../../src/infrastructure/messaging/sqs/invalid-message-error';
import {
  type IMessageHandler,
  type InboundMessage,
  MessageOutcome,
} from '../../../src/infrastructure/messaging/sqs/message-handler.port';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs/sqs-client';
import { DEAD_LETTER_ATTRIBUTES, SqsConsumerLoop } from '../../../src/infrastructure/messaging/sqs/sqs-consumer-loop';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { testInfraConfig } from '../../support/infra-config';
import { createTestQueues, type TestQueues } from '../../support/test-queues';
import { uuidv7 } from '../../support/uuid';

const MAX_RECEIVE_COUNT = 3;
const VISIBILITY_TIMEOUT_SECONDS = 2;
const PROCESS_SCRIPT = new URL('./sqs-consumer-process.ts', import.meta.url).pathname;

const consumerConfig = (overrides: Partial<SqsConsumerConfig> = {}): SqsConsumerConfig => ({
  ...DEFAULT_SQS_CONSUMER_CONFIG,
  waitTimeSeconds: 1,
  visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
  heartbeatIntervalMs: 500,
  maxReceiveCount: MAX_RECEIVE_COUNT,
  retry: { baseMs: 1_000, capMs: 1_000 },
  errorDelayMs: 50,
  shutdownTimeoutMs: 5_000,
  circuitBreaker: { failureThreshold: 1, openMs: 200 },
  ...overrides,
});

const until = async (condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

interface Call {
  readonly message: InboundMessage;
  readonly at: number;
}

const recording = (decide: (message: InboundMessage, calls: Call[]) => Promise<MessageOutcome> | MessageOutcome) => {
  const calls: Call[] = [];
  const handler: IMessageHandler = {
    handle: async (message) => {
      calls.push({ message, at: Date.now() });
      return decide(message, calls);
    },
  };
  return { handler, calls };
};

const queueDepth = async (client: SQSClient, queueUrl: string) => {
  const { Attributes = {} } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number.parseInt(Attributes.ApproximateNumberOfMessages ?? '-1', 10),
    inFlight: Number.parseInt(Attributes.ApproximateNumberOfMessagesNotVisible ?? '-1', 10),
  };
};

const receiveAll = async (client: SQSClient, queueUrl: string, waitTimeSeconds = 1): Promise<Message[]> => {
  const { Messages = [] } = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitTimeSeconds,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['All'],
    }),
  );
  return Messages;
};

const lines = (stream: ReadableStream<Uint8Array>) => {
  const events: Array<Record<string, unknown>> = [];
  void (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('{')) events.push(JSON.parse(line) as Record<string, unknown>);
        newline = buffer.indexOf('\n');
      }
    }
  })();
  return events;
};

describe('SQS consumer loop against LocalStack', () => {
  let queues: TestQueues;
  const consumers: SqsConsumerLoop[] = [];
  const children: Array<{ kill(signal?: number | NodeJS.Signals): void }> = [];

  const send = async (body: unknown, groupId = uuidv7()): Promise<string> => {
    const { MessageId } = await queues.client.send(
      new SendMessageCommand({
        QueueUrl: queues.commands.url,
        MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
        MessageGroupId: groupId,
        MessageDeduplicationId: uuidv7(),
      }),
    );
    return MessageId ?? '';
  };

  const consumer = (
    handler: IMessageHandler,
    options: { config?: Partial<SqsConsumerConfig>; readiness?: () => Promise<void> } = {},
  ) => {
    const errors: Array<{ error: unknown; operation: string }> = [];
    const loop = new SqsConsumerLoop({
      client: queues.client,
      queue: { url: queues.commands.url },
      deadLetterQueue: { url: queues.commands.dlqUrl },
      handler,
      config: consumerConfig(options.config),
      readiness: options.readiness ?? (async () => undefined),
      onError: (error, operation) => errors.push({ error, operation }),
    });
    consumers.push(loop);
    return { loop, errors };
  };

  const childEnv = (extra: Record<string, string>) => {
    const { endpoint, region, accessKeyId, secretAccessKey } = testInfraConfig().sqs;
    return {
      ...process.env,
      SQS_ENDPOINT: endpoint,
      AWS_REGION: region,
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
      SQS_COMMANDS_QUEUE_URL: queues.commands.url,
      SQS_COMMANDS_DLQ_URL: queues.commands.dlqUrl,
      SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
      SQS_CONSUMER_HEARTBEAT_INTERVAL_MS: '500',
      SQS_MAX_RECEIVE_COUNT: `${MAX_RECEIVE_COUNT}`,
      ...extra,
    };
  };

  const spawnConsumer = (extra: Record<string, string>) => {
    const child = Bun.spawn([process.execPath, 'run', PROCESS_SCRIPT], {
      env: childEnv(extra),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.push(child);
    return { child, events: lines(child.stdout) };
  };

  beforeEach(async () => {
    await ensureInfraUp();
    queues = await createTestQueues({ maxReceiveCount: MAX_RECEIVE_COUNT, visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS });
  });

  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((loop) => loop.stop(1_000)));
    for (const child of children.splice(0)) child.kill('SIGKILL');
    await queues?.destroy();
  });

  it('hands the parsed body to the handler and deletes the message only after it returned ack', async () => {
    const groupId = uuidv7();
    const { handler, calls } = recording(async () => {
      await Bun.sleep(300);
      return MessageOutcome.ack();
    });
    const sqsMessageId = await send({ messageId: 'msg-1', type: 'WagerTransactionRequested' }, groupId);
    const { loop } = consumer(handler);

    loop.start();
    await until(() => calls.length === 1, 10_000, 'the handler');
    expect(await queueDepth(queues.client, queues.commands.url)).toEqual({ visible: 0, inFlight: 1 });
    await until(async () => (await queueDepth(queues.client, queues.commands.url)).inFlight === 0, 5_000, 'the ack');
    await loop.stop();

    expect(calls[0]?.message).toMatchObject({
      body: { messageId: 'msg-1', type: 'WagerTransactionRequested' },
      sqsMessageId,
      receiveCount: 1,
      messageGroupId: groupId,
    });
    expect(calls[0]?.message.sentAt).toBeInstanceOf(Date);
    expect(await queueDepth(queues.client, queues.commands.url)).toEqual({ visible: 0, inFlight: 0 });
    expect(await receiveAll(queues.client, queues.commands.dlqUrl, 0)).toEqual([]);
  });

  it('retries a transient failure with backoff and never dead-letters it early', async () => {
    const { handler, calls } = recording((message) => {
      if (message.receiveCount < MAX_RECEIVE_COUNT) {
        throw new TransientInfrastructureError('lock timeout', '55P03', { cause: undefined });
      }
      return MessageOutcome.ack();
    });
    await send({ messageId: 'msg-transient' });
    const { loop } = consumer(handler);

    loop.start();
    await until(() => calls.length === MAX_RECEIVE_COUNT, 15_000, 'every retry');
    await until(async () => (await queueDepth(queues.client, queues.commands.url)).inFlight === 0, 5_000, 'the ack');
    await loop.stop();

    expect(calls.map((call) => call.message.receiveCount)).toEqual([1, 2, 3]);
    for (let index = 1; index < calls.length; index++) {
      expect(calls[index]!.at - calls[index - 1]!.at).toBeGreaterThanOrEqual(900);
    }
    expect(await receiveAll(queues.client, queues.commands.dlqUrl, 0)).toEqual([]);
  });

  it('dead-letters a poison message explicitly, with its reason, on the first receive', async () => {
    const poisonGroup = uuidv7();
    const openingGroup = uuidv7();
    const { handler, calls } = recording(() => {
      throw new InvalidMessageError('contract_violation', 'OPENING is internal');
    });
    const poisonId = await send('{not json', poisonGroup);
    const openingId = await send({ messageId: 'msg-opening', data: { kind: 'OPENING' } }, openingGroup);
    const { loop } = consumer(handler);

    loop.start();
    const deadLetters: Message[] = [];
    await until(
      async () => {
        deadLetters.push(...(await receiveAll(queues.client, queues.commands.dlqUrl)));
        return deadLetters.length === 2;
      },
      10_000,
      'both dead letters',
    );
    await loop.stop();

    const byId = new Map(
      deadLetters.map((message) => [message.MessageAttributes?.[DEAD_LETTER_ATTRIBUTES.sourceMessageId]?.StringValue, message]),
    );
    const poison = byId.get(poisonId);
    expect(poison?.Body).toBe('{not json');
    expect(poison?.Attributes?.MessageGroupId).toBe(poisonGroup);
    expect(poison?.MessageAttributes?.[DEAD_LETTER_ATTRIBUTES.reason]?.StringValue).toBe('invalid_json');
    expect(poison?.MessageAttributes?.[DEAD_LETTER_ATTRIBUTES.receiveCount]?.StringValue).toBe('1');
    const opening = byId.get(openingId);
    expect(opening?.Attributes?.MessageGroupId).toBe(openingGroup);
    expect(opening?.MessageAttributes?.[DEAD_LETTER_ATTRIBUTES.reason]?.StringValue).toBe('contract_violation');
    expect(opening?.MessageAttributes?.[DEAD_LETTER_ATTRIBUTES.detail]?.StringValue).toBe('OPENING is internal');
    expect(calls).toHaveLength(1);
    expect(await queueDepth(queues.client, queues.commands.url)).toEqual({ visible: 0, inFlight: 0 });
  });

  it('leaves the redrive policy as the safety net for a message that is never settled', async () => {
    const { handler, calls } = recording(() => MessageOutcome.retry(0));
    const sqsMessageId = await send({ messageId: 'msg-stuck' });
    const { loop } = consumer(handler);

    loop.start();
    const deadLetters: Message[] = [];
    await until(
      async () => {
        deadLetters.push(...(await receiveAll(queues.client, queues.commands.dlqUrl, 0)));
        return deadLetters.length === 1;
      },
      20_000,
      'the redrive',
    );
    await loop.stop();

    expect(calls.map((call) => call.message.receiveCount)).toEqual([1, 2, 3]);
    expect(deadLetters[0]?.MessageId).toBe(sqsMessageId);
    expect(deadLetters[0]?.MessageAttributes?.[DEAD_LETTER_ATTRIBUTES.reason]).toBeUndefined();
  });

  it('keeps a long-running message invisible with the heartbeat', async () => {
    const { handler, calls } = recording(async () => {
      await Bun.sleep(VISIBILITY_TIMEOUT_SECONDS * 1_000 * 2);
      return MessageOutcome.ack();
    });
    await send({ messageId: 'msg-slow' });
    const { loop, errors } = consumer(handler);
    const rival = createSqsClient({ ...testInfraConfig().sqs, credentials: testInfraConfig().sqs, maxAttempts: 1 });

    try {
      loop.start();
      await until(() => calls.length === 1, 10_000, 'the handler');
      const stolen: Message[] = [];
      const deadline = Date.now() + VISIBILITY_TIMEOUT_SECONDS * 1_000 * 1.5;
      while (Date.now() < deadline) stolen.push(...(await receiveAll(rival, queues.commands.url, 1)));
      await until(async () => (await queueDepth(queues.client, queues.commands.url)).inFlight === 0, 10_000, 'the ack');
      await loop.stop();

      expect(stolen).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      rival.destroy();
    }
  });

  it('does not receive while the circuit is open, so the receive count is not burned', async () => {
    let ready = false;
    const { handler, calls } = recording(() => MessageOutcome.ack());
    await send({ messageId: 'msg-paused' });
    const { loop } = consumer(handler, {
      readiness: async () => {
        if (!ready) throw new Error('PostgreSQL is down');
      },
    });

    loop.start();
    await until(() => loop.isCircuitOpen, 5_000, 'the circuit to open');
    await Bun.sleep(1_500);
    expect(calls).toHaveLength(0);
    expect(await queueDepth(queues.client, queues.commands.url)).toEqual({ visible: 1, inFlight: 0 });
    expect(loop.isCircuitOpen).toBe(true);

    ready = true;
    await until(() => calls.length === 1, 10_000, 'the handler after the circuit closed');
    await loop.stop();

    expect(calls[0]?.message.receiveCount).toBe(1);
    expect(loop.isCircuitOpen).toBe(false);
  });

  it('on SIGTERM finishes the message in flight, hands back the rest and exits 0', async () => {
    const groupId = uuidv7();
    const ids = [];
    for (let index = 0; index < 3; index++) ids.push(await send({ messageId: `msg-${index}` }, groupId));
    const { child, events } = spawnConsumer({
      FAULT_INJECTION: 'slow_handler',
      FAULT_SLOW_HANDLER_MS: '1500',
      SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '30',
      SHUTDOWN_TIMEOUT_MS: '5000',
    });

    await until(() => events.some((event) => event.event === 'started'), 15_000, 'the first message to start');
    const signalledAt = Date.now();
    child.kill('SIGTERM');
    const exitCode = await child.exited;
    const shutdownMs = Date.now() - signalledAt;

    expect(exitCode).toBe(0);
    expect(shutdownMs).toBeLessThan(5_000);
    const handled = events.filter((event) => event.event === 'handled').map((event) => event.sqsMessageId);
    expect(handled).toEqual([ids[0]]);
    expect(events.find((event) => event.event === 'stopped')).toMatchObject({ graceful: true });

    const handedBack: Message[] = [];
    await until(
      async () => {
        handedBack.push(...(await receiveAll(queues.client, queues.commands.url, 1)));
        return handedBack.length >= 2;
      },
      5_000,
      'the unstarted messages to be handed back (their visibility was 30s)',
    );
    expect(handedBack.map((message) => message.MessageId)).toEqual([ids[1], ids[2]]);
    expect(handedBack.map((message) => message.Attributes?.ApproximateReceiveCount)).toEqual(['2', '2']);
  });

  it('redelivers a message whose ack was lost to a crash after the commit, and handles it again', async () => {
    const sqsMessageId = await send({ messageId: 'msg-crash' });
    const { child, events } = spawnConsumer({
      FAULT_INJECTION: 'crash_after_commit_before_ack',
      SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: `${VISIBILITY_TIMEOUT_SECONDS}`,
    });

    await child.exited;
    expect(child.signalCode).toBe('SIGKILL');
    expect(events.filter((event) => event.event === 'handled').map((event) => event.sqsMessageId)).toEqual([sqsMessageId]);

    const { handler, calls } = recording(() => MessageOutcome.ack());
    const { loop } = consumer(handler);
    loop.start();
    await until(() => calls.length === 1, 15_000, 'the redelivery');
    await until(async () => (await queueDepth(queues.client, queues.commands.url)).inFlight === 0, 5_000, 'the ack');
    await loop.stop();

    expect(calls[0]?.message).toMatchObject({ sqsMessageId, receiveCount: 2, body: { messageId: 'msg-crash' } });
    expect(await queueDepth(queues.client, queues.commands.url)).toEqual({ visible: 0, inFlight: 0 });
  });
});
