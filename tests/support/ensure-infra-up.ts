import { ListQueuesCommand } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { postgresUrl, testInfraConfig, type TestInfraConfig } from './infra-config';
import { createSqsClient } from './test-queues';

const HINT = 'Start it with `bun run infra:up` (docker compose project "jungle-wagering").';

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const checkPostgres = async (config: TestInfraConfig): Promise<void> => {
  const client = new Client({
    connectionString: postgresUrl(config, config.postgres.adminDatabase),
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (error) {
    const { host, port } = config.postgres;
    throw new Error(`PostgreSQL is not reachable at ${host}:${port} (${describeError(error)}). ${HINT}`, {
      cause: error,
    });
  } finally {
    await client.end().catch(() => undefined);
  }
};

const checkSqs = async (config: TestInfraConfig): Promise<void> => {
  const client = createSqsClient(config);
  try {
    await client.send(new ListQueuesCommand({}), { abortSignal: AbortSignal.timeout(3000) });
  } catch (error) {
    throw new Error(`SQS is not reachable at ${config.sqs.endpoint} (${describeError(error)}). ${HINT}`, {
      cause: error,
    });
  } finally {
    client.destroy();
  }
};

export const ensureInfraUp = async (config: TestInfraConfig = testInfraConfig()): Promise<void> => {
  const results = await Promise.allSettled([checkPostgres(config), checkSqs(config)]);
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [describeError(result.reason)] : []));
  if (failures.length > 0) throw new Error(`Test infrastructure is down:\n- ${failures.join('\n- ')}`);
};
