import { readIntegerEnv } from './integer-env';

type Env = Readonly<Record<string, string | undefined>>;

export type SqsQueueRef = { readonly url: string } | { readonly name: string };

export interface SqsConfig {
  /** Ausente na AWS (o SDK resolve pela region), LocalStack em desenvolvimento e testes. */
  readonly endpoint?: string;
  readonly region: string;
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly maxAttempts: number;
  readonly eventsQueue: SqsQueueRef;
  readonly commandsQueue: SqsQueueRef;
  readonly commandsDeadLetterQueue: SqsQueueRef;
}

export const DEFAULT_EVENTS_QUEUE_NAME = 'wagering-events.fifo';
export const DEFAULT_COMMANDS_QUEUE_NAME = 'wager-transactions.fifo';
export const DEFAULT_COMMANDS_DLQ_NAME = 'wager-transactions-dlq.fifo';

const optional = (env: Env, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

const readEndpoint = (env: Env): string | undefined => {
  const endpoint = optional(env, 'SQS_ENDPOINT');
  if (endpoint !== undefined && !/^https?:\/\/[^/\s]+/.test(endpoint)) {
    throw new Error(`Invalid SQS_ENDPOINT: "${endpoint}" is not an http(s) URL`);
  }
  return endpoint;
};

const readCredentials = (env: Env): SqsConfig['credentials'] => {
  const accessKeyId = optional(env, 'AWS_ACCESS_KEY_ID');
  const secretAccessKey = optional(env, 'AWS_SECRET_ACCESS_KEY');
  if (accessKeyId === undefined && secretAccessKey === undefined) return undefined;
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together');
  }
  return { accessKeyId, secretAccessKey };
};

const readQueue = (env: Env, prefix: string, label: string, fallback: string): SqsQueueRef => {
  const url = optional(env, `${prefix}_URL`);
  const name = url ?? optional(env, `${prefix}_NAME`) ?? fallback;
  if (!name.endsWith('.fifo')) throw new Error(`The ${label} queue must be FIFO (.fifo), got "${name}"`);
  return url === undefined ? { name } : { url };
};

/** Todo SQS_*_URL tem prioridade sobre o SQS_*_NAME correspondente, que é resolvido com GetQueueUrl no primeiro uso. */
export const readSqsConfig = (env: Env): SqsConfig => {
  const maxAttempts = readIntegerEnv(env, 'SQS_MAX_ATTEMPTS', 3);
  if (maxAttempts === 0) throw new Error('Invalid SQS_MAX_ATTEMPTS: must be at least 1');
  const endpoint = readEndpoint(env);
  const credentials = readCredentials(env);
  return {
    ...(endpoint === undefined ? {} : { endpoint }),
    region: optional(env, 'AWS_REGION') ?? 'us-east-1',
    ...(credentials === undefined ? {} : { credentials }),
    maxAttempts,
    eventsQueue: readQueue(env, 'SQS_EVENTS_QUEUE', 'events', DEFAULT_EVENTS_QUEUE_NAME),
    commandsQueue: readQueue(env, 'SQS_COMMANDS_QUEUE', 'commands', DEFAULT_COMMANDS_QUEUE_NAME),
    commandsDeadLetterQueue: readQueue(env, 'SQS_COMMANDS_DLQ', 'commands dead-letter', DEFAULT_COMMANDS_DLQ_NAME),
  };
};
