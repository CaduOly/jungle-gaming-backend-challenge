import { GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Subprocess } from 'bun';
import { Client } from 'pg';
import { assertWalletConsistency } from '../../support/assert-wallet-consistency';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { testInfraConfig } from '../../support/infra-config';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { createTestQueues, type TestQueues } from '../../support/test-queues';
import { uuidv7 } from '../../support/uuid';

const MAIN = new URL('../../../src/main.ts', import.meta.url).pathname;
const MIGRATE = new URL('../../../src/infrastructure/persistence/mikro-orm/migrate.ts', import.meta.url).pathname;

/** Uma linha de log JSON de uma réplica; `message` é a chave de mensagem do pino. */
export type LogEvent = Readonly<Record<string, unknown>> & { readonly message: string };

/**
 * Leases, visibility e backoffs curtos, para crash, restart e queda se resolverem em segundos. Cada valor ainda
 * passa na validação de produção (lease > batch x timeout, heartbeat < visibility).
 */
const FAST_ENV: Readonly<Record<string, string>> = {
  DB_LOCK_TIMEOUT_MS: '1000',
  DB_POOL_ACQUIRE_TIMEOUT_MS: '2000',
  HTTP_REQUEST_TIMEOUT_MS: '3000',
  HTTP_RETRY_AFTER_SECONDS: '1',
  HEALTH_READINESS_TIMEOUT_MS: '500',
  SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
  SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '4',
  SQS_CONSUMER_HEARTBEAT_INTERVAL_MS: '1000',
  SQS_CONSUMER_RETRY_BASE_MS: '200',
  SQS_CONSUMER_RETRY_CAP_MS: '1000',
  SQS_CONSUMER_ERROR_DELAY_MS: '200',
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: '1',
  CIRCUIT_BREAKER_OPEN_MS: '500',
  SHUTDOWN_TIMEOUT_MS: '5000',
  SQS_CONSUMER_HANDLER_TIMEOUT_MS: '3000',
  OUTBOX_LEASE_MS: '3000',
  OUTBOX_BATCH_SIZE: '10',
  OUTBOX_PUBLISH_TIMEOUT_MS: '250',
  OUTBOX_POLL_INTERVAL_MS: '100',
  OUTBOX_BACKOFF_BASE_MS: '100',
  OUTBOX_BACKOFF_CAP_MS: '1000',
  PENDING_BATCH_SIZE: '2',
  PENDING_LEASE_MS: '5000',
  PENDING_POLL_INTERVAL_MS: '200',
  PENDING_BACKOFF_BASE_MS: '200',
  PENDING_BACKOFF_CAP_MS: '3000',
  PENDING_MAX_ATTEMPTS: '10',
};

export const until = async (condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await Bun.sleep(100);
  }
};

const collectJsonLines = (stream: ReadableStream<Uint8Array>, into: LogEvent[]): void => {
  void (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('{')) {
          try {
            into.push(JSON.parse(line) as LogEvent);
          } catch {
            // não é um dos nossos
          }
        }
        newline = buffer.indexOf('\n');
      }
    }
  })();
};

const drainText = (stream: ReadableStream<Uint8Array>, into: string[]): void => {
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) into.push(decoder.decode(chunk, { stream: true }));
  })();
};

/** Um processo `bun run src/main.ts`, o mesmo entry point que a imagem Docker roda. */
export class Instance {
  readonly events: LogEvent[] = [];
  readonly stderr: string[] = [];
  private process: Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  port = 0;

  constructor(
    readonly id: string,
    private readonly env: Record<string, string>,
  ) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get running(): boolean {
    return this.process !== undefined && this.process.exitCode === null && this.process.signalCode === null;
  }

  async start(): Promise<void> {
    const from = this.events.length;
    const child = Bun.spawn([process.execPath, 'run', MAIN], {
      env: { ...this.env, INSTANCE_ID: this.id, PORT: '0' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.process = child;
    collectJsonLines(child.stdout, this.events);
    drainText(child.stderr, this.stderr);
    await until(
      () => this.events.slice(from).some((event) => event.message === 'started') || child.exitCode !== null,
      30_000,
      `${this.id} to start`,
    );
    if (child.exitCode !== null) throw new Error(`${this.id} exited with ${child.exitCode}: ${this.stderr.join('')}`);
    const started = this.events.slice(from).find((event) => event.message === 'started');
    this.port = Number.parseInt(String(started?.port), 10);
  }

  async ready(): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${this.baseUrl}/health/ready`, { signal: AbortSignal.timeout(3_000) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async waitReady(timeoutMs = 30_000): Promise<void> {
    await until(async () => (await this.ready().catch(() => ({ status: 0 }))).status === 200, timeoutMs, `${this.id} to be ready`);
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    this.process?.kill(signal);
  }

  async exited(): Promise<number | null> {
    await this.process?.exited;
    return this.process?.exitCode ?? null;
  }

  processed(): LogEvent[] {
    return this.events.filter((event) => event.message === 'wager command processed');
  }
}

export interface ClusterOptions {
  readonly size?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface Wallet {
  readonly id: string;
  readonly playerId: string;
}

/**
 * ≥3 processos reais sobre um banco novo e um conjunto de filas novas (sufixos únicos), do jeito que a stack do
 * compose roda: migrations uma vez, depois todas as réplicas com todos os papéis.
 */
export class Cluster {
  readonly wallets = new Set<string>();

  private constructor(
    readonly database: TestDatabase,
    readonly queues: TestQueues,
    readonly sql: Client,
    readonly instances: readonly Instance[],
  ) {}

  static async start(options: ClusterOptions = {}): Promise<Cluster> {
    await ensureInfraUp();
    const database = await createTestDatabase();
    const migration = Bun.spawnSync([process.execPath, 'run', MIGRATE, 'up'], {
      env: { ...process.env, DATABASE_URL: database.url },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (migration.exitCode !== 0) throw new Error(`migrate up failed: ${migration.stderr.toString()}`);
    const queues = await createTestQueues({ maxReceiveCount: 100, visibilityTimeoutSeconds: 4 });
    const sql = new Client({ connectionString: database.url });
    await sql.connect();
    const { sqs } = testInfraConfig();
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...FAST_ENV,
      DATABASE_URL: database.url,
      SQS_ENDPOINT: sqs.endpoint,
      AWS_REGION: sqs.region,
      AWS_ACCESS_KEY_ID: sqs.accessKeyId,
      AWS_SECRET_ACCESS_KEY: sqs.secretAccessKey,
      SQS_COMMANDS_QUEUE_URL: queues.commands.url,
      SQS_COMMANDS_DLQ_URL: queues.commands.dlqUrl,
      SQS_EVENTS_QUEUE_URL: queues.events.url,
      APP_ROLES: 'api,consumer,outbox,pending-worker',
      FAULT_INJECTION: '',
      ...options.env,
    };
    const run = uuidv7().slice(-6);
    const instances = Array.from({ length: options.size ?? 3 }, (_, index) => new Instance(`inst-${run}-${index + 1}`, env));
    const cluster = new Cluster(database, queues, sql, instances);
    try {
      await cluster.startAll();
    } catch (error) {
      await cluster.destroy();
      throw error;
    }
    return cluster;
  }

  async startAll(): Promise<void> {
    await Promise.all(this.instances.map((instance) => instance.start()));
    await Promise.all(this.instances.map((instance) => instance.waitReady()));
  }

  killAll(signal: NodeJS.Signals = 'SIGKILL'): Promise<unknown> {
    for (const instance of this.instances) instance.kill(signal);
    return Promise.all(this.instances.map((instance) => instance.exited()));
  }

  instance(index: number): Instance {
    const instance = this.instances[index % this.instances.length];
    if (instance === undefined) throw new Error('empty cluster');
    return instance;
  }

  async http(
    index: number,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; instanceId: string | null; body: Record<string, unknown>; retryAfter: string | null }> {
    const response = await fetch(`${this.instance(index).baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Provider-Id': 'provider-a', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    return {
      status: response.status,
      instanceId: response.headers.get('x-instance-id'),
      retryAfter: response.headers.get('retry-after'),
      body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
    };
  }

  async openWallet(index: number, amount = '1000.00'): Promise<Wallet> {
    const playerId = uuidv7();
    const response = await this.http(index, 'POST', '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
    if (response.status !== 201) throw new Error(`wallet creation answered ${response.status}: ${JSON.stringify(response.body)}`);
    const id = (response.body.data as { id: string }).id;
    this.wallets.add(id);
    return { id, playerId };
  }

  wager(wallet: Wallet, kind: string, amount: string, reference?: string, externalTransactionId = `tx-${uuidv7()}`) {
    return {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${reference ?? externalTransactionId}`,
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
    };
  }

  submitHttp(index: number, data: ReturnType<Cluster['wager']>) {
    return this.http(index, 'POST', '/wagering/transactions', data, { 'Idempotency-Key': `provider-a:${data.externalTransactionId}` });
  }

  async submitSqs(data: ReturnType<Cluster['wager']>, messageId = `msg-${uuidv7()}`): Promise<string> {
    await this.queues.client.send(
      new SendMessageCommand({
        QueueUrl: this.queues.commands.url,
        MessageGroupId: data.walletId,
        MessageDeduplicationId: uuidv7(),
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: { ...data, idempotencyKey: `provider-a:${data.externalTransactionId}` },
        }),
      }),
    );
    return messageId;
  }

  async queueDepth(url: string): Promise<number> {
    const { Attributes = {} } = await this.queues.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return (
      Number.parseInt(Attributes.ApproximateNumberOfMessages ?? '0', 10) +
      Number.parseInt(Attributes.ApproximateNumberOfMessagesNotVisible ?? '0', 10)
    );
  }

  async count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await this.sql.query<{ total: number }>(`SELECT count(*)::int AS total FROM ${sql}`, params);
    return rows[0]?.total ?? 0;
  }

  /** Nada mais a fazer em lugar nenhum: outbox publicado, nenhuma referência pendente, fila de comandos vazia. */
  async quiescent(): Promise<boolean> {
    const [unpublished, pending, depth] = await Promise.all([
      this.count('outbox_messages WHERE published_at IS NULL'),
      this.count(`wager_transactions WHERE status = 'PENDING_REFERENCE'`),
      this.queueDepth(this.queues.commands.url),
    ]);
    return unpublished === 0 && pending === 0 && depth === 0;
  }

  async deadLetters(): Promise<unknown[]> {
    const { Messages = [] } = await this.queues.client.send(
      new ReceiveMessageCommand({ QueueUrl: this.queues.commands.dlqUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    return Messages;
  }

  /** Toda wallet que a execução tocou: balance == ledger, entries encadeadas, versões em sincronia (invariante do §13). */
  async assertAllWalletsConsistent(): Promise<void> {
    const { rows } = await this.sql.query<{ id: string }>('SELECT id FROM wallets');
    for (const { id } of rows) await assertWalletConsistency(this.sql, id);
  }

  async destroy(): Promise<void> {
    await this.killAll().catch(() => undefined);
    await this.sql.end().catch(() => undefined);
    await this.queues.destroy().catch(() => undefined);
    await this.database.drop().catch(() => undefined);
  }
}
