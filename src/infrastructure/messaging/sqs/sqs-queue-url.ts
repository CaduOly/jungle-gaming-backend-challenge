import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { SqsQueueRef } from '../../config/sqs-config';

/** Resolves a queue name with GetQueueUrl once; a failed lookup is not cached, so the next call retries. */
export class SqsQueueUrl {
  private resolved: Promise<string> | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queue: SqsQueueRef,
    private readonly requestTimeoutMs: number,
  ) {
    if ('url' in queue) this.resolved = Promise.resolve(queue.url);
  }

  get(): Promise<string> {
    this.resolved ??= this.lookUp().catch((error: unknown) => {
      this.resolved = undefined;
      throw error;
    });
    return this.resolved;
  }

  private async lookUp(): Promise<string> {
    if ('url' in this.queue) return this.queue.url;
    const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: this.queue.name }), {
      abortSignal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (QueueUrl === undefined) throw new Error(`SQS did not return a url for ${this.queue.name}`);
    return QueueUrl;
  }
}
