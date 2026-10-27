export interface TestInfraConfig {
  readonly postgres: {
    readonly host: string;
    readonly port: string;
    readonly user: string;
    readonly password: string;
    readonly adminDatabase: string;
  };
  readonly sqs: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
}

const read = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
};

export const testInfraConfig = (): TestInfraConfig => ({
  postgres: {
    host: read('POSTGRES_HOST', 'localhost'),
    port: read('POSTGRES_HOST_PORT', '55432'),
    user: read('POSTGRES_USER', 'wagering'),
    password: read('POSTGRES_PASSWORD', 'wagering'),
    adminDatabase: read('POSTGRES_DB', 'wagering'),
  },
  sqs: {
    endpoint: read('SQS_ENDPOINT', `http://localhost:${read('LOCALSTACK_HOST_PORT', '4566')}`),
    region: read('AWS_REGION', 'us-east-1'),
    accessKeyId: read('AWS_ACCESS_KEY_ID', 'test'),
    secretAccessKey: read('AWS_SECRET_ACCESS_KEY', 'test'),
  },
});

export const postgresUrl = (config: TestInfraConfig, database: string): string => {
  const { host, port, user, password } = config.postgres;
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
};
