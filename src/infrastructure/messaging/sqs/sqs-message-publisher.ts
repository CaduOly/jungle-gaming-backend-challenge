import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { OutboxMessage } from '../../../business/messaging/entity/outbox-message';
import type { IMessagePublisher } from '../../../business/messaging/port/message-publisher.port';
import type { SqsQueueRef } from '../../config/sqs-config';

export interface SqsMessagePublisherOptions {
  readonly requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/**
 * One FIFO group per aggregate keeps a wallet's events in order; the eventId as deduplication id makes a
 * republish inside SQS's 5-minute window a no-op. Past that window consumers still dedupe by eventId.
 */
export class SqsMessagePublisher implements IMessagePublisher {
  private queueUrl: Promise<string> | undefined;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly client: SQSClient,
    private readonly queue: SqsQueueRef,
    options: SqsMessagePublisherOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if ('url' in queue) this.queueUrl = Promise.resolve(queue.url);
  }

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.resolveQueueUrl(),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
      { abortSignal: AbortSignal.timeout(this.requestTimeoutMs) },
    );
  }

  private resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= this.lookUpQueueUrl().catch((error: unknown) => {
      this.queueUrl = undefined;
      throw error;
    });
    return this.queueUrl;
  }

  private async lookUpQueueUrl(): Promise<string> {
    if ('url' in this.queue) return this.queue.url;
    const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: this.queue.name }), {
      abortSignal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (QueueUrl === undefined) throw new Error(`SQS did not return a url for ${this.queue.name}`);
    return QueueUrl;
  }
}
