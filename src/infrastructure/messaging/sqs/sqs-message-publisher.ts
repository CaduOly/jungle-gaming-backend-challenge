import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { OutboxMessage } from '../../../business/messaging/entity/outbox-message';
import type { IMessagePublisher } from '../../../business/messaging/port/message-publisher.port';
import type { SqsQueueRef } from '../../config/sqs-config';
import { SqsQueueUrl } from './sqs-queue-url';

export interface SqsMessagePublisherOptions {
  readonly requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Um grupo FIFO por aggregate mantém os eventos de uma wallet em ordem, e o eventId como deduplication id faz um
 * republish dentro da janela de 5 minutos do SQS virar no-op. Passada essa janela os consumers ainda fazem dedup
 * por eventId.
 */
export class SqsMessagePublisher implements IMessagePublisher {
  private readonly queueUrl: SqsQueueUrl;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly client: SQSClient,
    queue: SqsQueueRef,
    options: SqsMessagePublisherOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.queueUrl = new SqsQueueUrl(client, queue, this.requestTimeoutMs);
  }

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl.get(),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
      { abortSignal: AbortSignal.timeout(this.requestTimeoutMs) },
    );
  }
}
