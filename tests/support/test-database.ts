import { Client } from 'pg';
import { postgresUrl, testInfraConfig, type TestInfraConfig } from './infra-config';
import { uniqueSuffix } from './uuid';

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  drop(): Promise<void>;
}

const withAdminClient = async <T>(config: TestInfraConfig, work: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client({ connectionString: postgresUrl(config, config.postgres.adminDatabase) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

export const createTestDatabase = async (config: TestInfraConfig = testInfraConfig()): Promise<TestDatabase> => {
  const name = `wagering_test_${uniqueSuffix()}`;
  await withAdminClient(config, (client) => client.query(`CREATE DATABASE "${name}"`));
  return {
    name,
    url: postgresUrl(config, name),
    drop: async () => {
      if (process.env.KEEP_TEST_DATABASES === '1') return;
      await withAdminClient(config, (client) => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    },
  };
};
