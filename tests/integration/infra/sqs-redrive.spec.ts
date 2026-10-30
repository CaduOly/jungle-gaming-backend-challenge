import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { createSqsClient, createTestQueues, type TestQueues } from '../../support/test-queues';
import { uuidv7 } from '../../support/uuid';

const MAX_RECEIVE_COUNT = 5;

const receiveOnce = async (client: SQSClient, queueUrl: string) => {
  const { Messages } = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      VisibilityTimeout: 0,
      WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'DeadLetterQueueSourceArn'],
    }),
  );
  return Messages?.[0];
};

describe('LocalStack SQS FIFO redrive (spike)', () => {
  let queues: TestQueues;

  beforeAll(async () => {
    await ensureInfraUp();
    queues = await createTestQueues({ maxReceiveCount: MAX_RECEIVE_COUNT });
  });

  afterAll(async () => {
    await queues?.destroy();
  });

  it('moves a message to the FIFO DLQ after maxReceiveCount receives without delete', async () => {
    const { client, commands } = queues;
    const body = JSON.stringify({ spike: uuidv7() });
    await client.send(
      new SendMessageCommand({
        QueueUrl: commands.url,
        MessageBody: body,
        MessageGroupId: uuidv7(),
        MessageDeduplicationId: uuidv7(),
      }),
    );

    const receiveCounts: string[] = [];
    for (let attempt = 1; attempt <= MAX_RECEIVE_COUNT; attempt++) {
      const message = await receiveOnce(client, commands.url);
      expect(message?.Body).toBe(body);
      receiveCounts.push(message?.Attributes?.ApproximateReceiveCount ?? '?');
    }
    expect(receiveCounts).toEqual(['1', '2', '3', '4', '5']);

    expect(await receiveOnce(client, commands.url)).toBeUndefined();

    const dead = await receiveOnce(client, commands.dlqUrl);
    expect(dead?.Body).toBe(body);
    expect(dead?.Attributes?.DeadLetterQueueSourceArn).toEndWith(`:wager-transactions-${queues.suffix}.fifo`);
  });

  it('compose init created the shared FIFO queues with redrive to their DLQs', async () => {
    const client = createSqsClient();
    try {
      for (const name of ['wager-transactions', 'wagering-events']) {
        const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: `${name}.fifo` }));
        const { Attributes } = await client.send(
          new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['FifoQueue', 'RedrivePolicy'] }),
        );
        expect(Attributes?.FifoQueue).toBe('true');
        const redrive = JSON.parse(Attributes?.RedrivePolicy ?? '{}') as Record<string, unknown>;
        expect(`${redrive.maxReceiveCount}`).toBe(process.env.SQS_MAX_RECEIVE_COUNT ?? '100');
        expect(`${redrive.deadLetterTargetArn}`).toEndWith(`:${name}-dlq.fifo`);
      }
    } finally {
      client.destroy();
    }
  });
});
