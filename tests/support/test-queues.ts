import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { testInfraConfig, type TestInfraConfig } from './infra-config';
import { uniqueSuffix } from './uuid';

export interface FifoQueuePair {
  readonly url: string;
  readonly dlqUrl: string;
}

export interface TestQueues {
  readonly suffix: string;
  readonly client: SQSClient;
  readonly commands: FifoQueuePair;
  readonly events: FifoQueuePair;
  destroy(): Promise<void>;
}

export interface TestQueueOptions {
  readonly maxReceiveCount?: number;
  readonly visibilityTimeoutSeconds?: number;
  readonly client?: SQSClient;
}

type ResolvedQueueOptions = Required<Pick<TestQueueOptions, 'maxReceiveCount' | 'visibilityTimeoutSeconds'>>;

export class TestQueuesCreationError extends Error {
  constructor(
    readonly suffix: string,
    cause: unknown,
  ) {
    super(`Could not create test queues with suffix ${suffix}; partially created queues were deleted`, { cause });
    this.name = 'TestQueuesCreationError';
  }
}

export const createSqsClient = (config: TestInfraConfig = testInfraConfig()): SQSClient =>
  new SQSClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
    useQueueUrlAsEndpoint: false,
  });

const createFifoQueue = async (
  client: SQSClient,
  name: string,
  attributes: Record<string, string>,
  created: string[],
): Promise<string> => {
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...attributes },
    }),
  );
  if (QueueUrl === undefined) throw new Error(`SQS did not return a url for ${name}`);
  created.push(QueueUrl);
  return QueueUrl;
};

const queueArn = async (client: SQSClient, url: string): Promise<string> => {
  const { Attributes } = await client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
  const arn = Attributes?.QueueArn;
  if (arn === undefined) throw new Error(`SQS did not return an ARN for ${url}`);
  return arn;
};

const createPairWithRedrive = async (
  client: SQSClient,
  baseName: string,
  suffix: string,
  options: ResolvedQueueOptions,
  created: string[],
): Promise<FifoQueuePair> => {
  const dlqUrl = await createFifoQueue(client, `${baseName}-dlq-${suffix}.fifo`, {}, created);
  const deadLetterTargetArn = await queueArn(client, dlqUrl);
  const url = await createFifoQueue(
    client,
    `${baseName}-${suffix}.fifo`,
    {
      VisibilityTimeout: `${options.visibilityTimeoutSeconds}`,
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn, maxReceiveCount: `${options.maxReceiveCount}` }),
    },
    created,
  );
  return { url, dlqUrl };
};

const deleteQueues = async (client: SQSClient, urls: readonly string[]): Promise<void> => {
  await Promise.allSettled(urls.map((QueueUrl) => client.send(new DeleteQueueCommand({ QueueUrl }))));
};

export const createTestQueues = async (
  options: TestQueueOptions = {},
  config: TestInfraConfig = testInfraConfig(),
): Promise<TestQueues> => {
  const resolved: ResolvedQueueOptions = {
    maxReceiveCount: options.maxReceiveCount ?? 5,
    visibilityTimeoutSeconds: options.visibilityTimeoutSeconds ?? 30,
  };
  const ownsClient = options.client === undefined;
  const client = options.client ?? createSqsClient(config);
  const release = (): void => {
    if (ownsClient) client.destroy();
  };
  const suffix = uniqueSuffix();
  const created: string[] = [];
  try {
    const commands = await createPairWithRedrive(client, 'wager-transactions', suffix, resolved, created);
    const events = await createPairWithRedrive(client, 'wagering-events', suffix, resolved, created);
    return {
      suffix,
      client,
      commands,
      events,
      destroy: async () => {
        await deleteQueues(client, created);
        release();
      },
    };
  } catch (error) {
    await deleteQueues(client, created);
    release();
    throw new TestQueuesCreationError(suffix, error);
  }
};
