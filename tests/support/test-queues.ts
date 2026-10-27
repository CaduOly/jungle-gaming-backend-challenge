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
): Promise<string> => {
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...attributes },
    }),
  );
  if (QueueUrl === undefined) throw new Error(`SQS did not return a url for ${name}`);
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
  options: Required<TestQueueOptions>,
): Promise<FifoQueuePair> => {
  const dlqUrl = await createFifoQueue(client, `${baseName}-dlq-${suffix}.fifo`, {});
  const deadLetterTargetArn = await queueArn(client, dlqUrl);
  const url = await createFifoQueue(client, `${baseName}-${suffix}.fifo`, {
    VisibilityTimeout: `${options.visibilityTimeoutSeconds}`,
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn, maxReceiveCount: `${options.maxReceiveCount}` }),
  });
  return { url, dlqUrl };
};

export const createTestQueues = async (
  options: TestQueueOptions = {},
  config: TestInfraConfig = testInfraConfig(),
): Promise<TestQueues> => {
  const resolved: Required<TestQueueOptions> = {
    maxReceiveCount: options.maxReceiveCount ?? 5,
    visibilityTimeoutSeconds: options.visibilityTimeoutSeconds ?? 30,
  };
  const client = createSqsClient(config);
  const suffix = uniqueSuffix();
  const commands = await createPairWithRedrive(client, 'wagering-commands', suffix, resolved);
  const events = await createPairWithRedrive(client, 'wagering-events', suffix, resolved);
  return {
    suffix,
    client,
    commands,
    events,
    destroy: async () => {
      const urls = [commands.url, commands.dlqUrl, events.url, events.dlqUrl];
      await Promise.allSettled(urls.map((QueueUrl) => client.send(new DeleteQueueCommand({ QueueUrl }))));
      client.destroy();
    },
  };
};
