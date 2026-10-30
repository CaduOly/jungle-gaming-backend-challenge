import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { IReadinessCheck } from './readiness-check.port';

/** GetQueueAttributes na fila que a instância depende: acessível, autorizada e a fila existe. */
export class SqsReadinessCheck implements IReadinessCheck {
  readonly name = 'sqs';

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async check(): Promise<void> {
    await this.client.send(new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ['QueueArn'] }));
  }
}
