import { describe, expect, it } from 'bun:test';
import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { OutboxMessage } from '../../../business/messaging/entity/outbox-message';
import { aFakeEvent } from '../../../../tests/support/fakes/fake-integration-event';
import { SqsMessagePublisher } from './sqs-message-publisher';

type Command = SendMessageCommand | GetQueueUrlCommand;

const stubClient = (respond: (command: Command) => unknown = () => ({})) => {
  const sent: Command[] = [];
  const client = {
    send: async (command: Command) => {
      sent.push(command);
      return respond(command);
    },
  } as unknown as SQSClient;
  return { client, sent };
};

const aMessage = () =>
  OutboxMessage.fromEvent(aFakeEvent({ eventId: 'event-42', aggregateId: 'wallet-7', correlationId: 'corr-9' }));

describe('SqsMessagePublisher', () => {
  it('sends the envelope grouped by aggregate and deduplicated by eventId', async () => {
    const { client, sent } = stubClient();
    const message = aMessage();

    await new SqsMessagePublisher(client, { url: 'http://sqs/000/wagering-events.fifo' }).publish(message);

    expect(sent).toHaveLength(1);
    const command = sent[0];
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command?.input).toEqual({
      QueueUrl: 'http://sqs/000/wagering-events.fifo',
      MessageBody: JSON.stringify(message.payload),
      MessageGroupId: 'wallet-7',
      MessageDeduplicationId: 'event-42',
    });
    expect(JSON.parse((command as SendMessageCommand).input.MessageBody ?? '')).toMatchObject({
      eventId: 'event-42',
      eventType: 'FakeHappened',
      aggregateId: 'wallet-7',
      correlationId: 'corr-9',
    });
  });

  it('resolves a queue name once and reuses the url', async () => {
    const { client, sent } = stubClient((command) =>
      command instanceof GetQueueUrlCommand ? { QueueUrl: 'http://sqs/000/wagering-events.fifo' } : {},
    );
    const publisher = new SqsMessagePublisher(client, { name: 'wagering-events.fifo' });

    await publisher.publish(aMessage());
    await publisher.publish(aMessage());

    expect(sent.map((command) => command.constructor.name)).toEqual([
      'GetQueueUrlCommand',
      'SendMessageCommand',
      'SendMessageCommand',
    ]);
    expect(sent[0]?.input).toEqual({ QueueName: 'wagering-events.fifo' });
    expect((sent[2] as SendMessageCommand).input.QueueUrl).toBe('http://sqs/000/wagering-events.fifo');
  });

  it('retries the lookup after a failed resolution instead of caching the error', async () => {
    let lookups = 0;
    const { client } = stubClient((command) => {
      if (!(command instanceof GetQueueUrlCommand)) return {};
      lookups += 1;
      if (lookups === 1) throw new Error('connection refused');
      return { QueueUrl: 'http://sqs/000/wagering-events.fifo' };
    });
    const publisher = new SqsMessagePublisher(client, { name: 'wagering-events.fifo' });

    await expect(publisher.publish(aMessage())).rejects.toThrow('connection refused');
    await publisher.publish(aMessage());
    expect(lookups).toBe(2);
  });

  it('propagates a send failure so the batch schedules a retry', async () => {
    const { client } = stubClient(() => {
      throw new Error('ServiceUnavailable');
    });
    await expect(new SqsMessagePublisher(client, { url: 'http://sqs/q.fifo' }).publish(aMessage())).rejects.toThrow(
      'ServiceUnavailable',
    );
  });
});
