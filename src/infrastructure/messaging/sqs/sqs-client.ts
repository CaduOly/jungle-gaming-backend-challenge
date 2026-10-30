import { SQSClient } from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../../config/sqs-config';

export type SqsClientConfig = Pick<SqsConfig, 'endpoint' | 'region' | 'credentials' | 'maxAttempts'>;

/** As queue urls path-style do LocalStack não podem sobrescrever o endpoint, por isso useQueueUrlAsEndpoint: false. */
export const createSqsClient = (config: SqsClientConfig): SQSClient =>
  new SQSClient({
    region: config.region,
    maxAttempts: config.maxAttempts,
    useQueueUrlAsEndpoint: false,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.credentials === undefined ? {} : { credentials: config.credentials }),
  });
