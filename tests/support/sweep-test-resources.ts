import { DeleteQueueCommand, ListQueuesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { postgresUrl, testInfraConfig, type TestInfraConfig } from './infra-config';
import { createSqsClient } from './test-queues';

const SUFFIX = '([0-9a-f]{32})';
const TEST_DATABASE_PATTERN = new RegExp(`^wagering_test_${SUFFIX}$`);
const TEST_QUEUE_PATTERN = new RegExp(
  `^(?:wager-transactions|wagering-commands|wagering-events)(?:-dlq)?-${SUFFIX}\\.fifo$`,
);
const DEFAULT_MIN_AGE_MS = 30 * 60 * 1000;

export interface SweepOptions {
  readonly minAgeMs?: number;
  readonly now?: number;
  readonly onlySuffixes?: ReadonlySet<string>;
}

export interface SweepReport {
  readonly databases: readonly string[];
  readonly queues: readonly string[];
}

export const testResourceSuffix = (name: string): string | undefined =>
  (TEST_DATABASE_PATTERN.exec(name) ?? TEST_QUEUE_PATTERN.exec(name))?.[1];

export const suffixCreatedAt = (suffix: string): number => Number.parseInt(suffix.slice(0, 12), 16);

export interface SweepCriteria {
  readonly minAgeMs: number;
  readonly now: number;
  readonly onlySuffixes?: ReadonlySet<string>;
}

/** Pure: a test resource, inside `onlySuffixes` when given, and at least `minAgeMs` old at `now`. */
export const isSweepable = (name: string, criteria: SweepCriteria): boolean => {
  const suffix = testResourceSuffix(name);
  if (suffix === undefined) return false;
  if (criteria.onlySuffixes !== undefined && !criteria.onlySuffixes.has(suffix)) return false;
  return criteria.now - suffixCreatedAt(suffix) >= criteria.minAgeMs;
};

const criteriaOf = (options: SweepOptions): SweepCriteria => ({
  minAgeMs: options.minAgeMs ?? DEFAULT_MIN_AGE_MS,
  now: options.now ?? Date.now(),
  ...(options.onlySuffixes === undefined ? {} : { onlySuffixes: options.onlySuffixes }),
});

const sweepDatabases = async (config: TestInfraConfig, criteria: SweepCriteria): Promise<string[]> => {
  const client = new Client({ connectionString: postgresUrl(config, config.postgres.adminDatabase) });
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'wagering\\_test\\_%'",
    );
    const doomed = rows.map((row) => row.datname).filter((name) => isSweepable(name, criteria));
    for (const name of doomed) await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    return doomed;
  } finally {
    await client.end();
  }
};

const listQueueUrls = async (client: SQSClient): Promise<string[]> => {
  const urls: string[] = [];
  let NextToken: string | undefined;
  do {
    const page = await client.send(new ListQueuesCommand({ QueueNamePrefix: 'wager', MaxResults: 1000, NextToken }));
    urls.push(...(page.QueueUrls ?? []));
    NextToken = page.NextToken;
  } while (NextToken !== undefined);
  return urls;
};

const queueName = (url: string): string => url.slice(url.lastIndexOf('/') + 1);

const sweepQueues = async (config: TestInfraConfig, criteria: SweepCriteria): Promise<string[]> => {
  const client = createSqsClient(config);
  try {
    const doomed = (await listQueueUrls(client)).filter((url) => isSweepable(queueName(url), criteria));
    await Promise.all(doomed.map((QueueUrl) => client.send(new DeleteQueueCommand({ QueueUrl }))));
    return doomed.map(queueName);
  } finally {
    client.destroy();
  }
};

export const sweepTestResources = async (
  options: SweepOptions = {},
  config: TestInfraConfig = testInfraConfig(),
): Promise<SweepReport> => {
  const criteria = criteriaOf(options);
  const [databases, queues] = await Promise.all([sweepDatabases(config, criteria), sweepQueues(config, criteria)]);
  return { databases, queues };
};

const minAgeFromArgs = (args: readonly string[]): number => {
  if (args.includes('--all')) return 0;
  const flag = args.find((arg) => arg.startsWith('--older-than-minutes='));
  if (flag === undefined) return DEFAULT_MIN_AGE_MS;
  const raw = flag.slice('--older-than-minutes='.length);
  if (!/^\d{1,6}$/.test(raw)) throw new Error(`Invalid --older-than-minutes: ${raw}`);
  return Number.parseInt(raw, 10) * 60 * 1000;
};

const USAGE = `Usage: bun run test:sweep [--older-than-minutes=N | --all | --help]

Drops leaked test databases (wagering_test_<suffix>) and test queues
(wager-transactions[-dlq]-<suffix>.fifo, wagering-events[-dlq]-<suffix>.fifo and the legacy
wagering-commands[-dlq]-<suffix>.fifo). The four compose queues are never touched.
The age comes from the UUIDv7 timestamp in the suffix.

  --older-than-minutes=N  only resources created more than N minutes ago (default: 30)
  --all                   every test resource, regardless of age
  --help                  show this message

WARNING: the stack is shared. A sweep removes resources of runs that are still in progress
if they are older than the threshold. The default of 30 minutes can kill a long run
(load tests, long --rerun-each loops): while one is running, pass a larger
--older-than-minutes, and never use --all while someone else is testing.`;

if (import.meta.main) {
  if (process.argv.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }
  const report = await sweepTestResources({ minAgeMs: minAgeFromArgs(process.argv.slice(2)) });
  console.log(`Dropped ${report.databases.length} test databases and ${report.queues.length} test queues.`);
}
