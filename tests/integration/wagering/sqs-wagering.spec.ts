import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { GetQueueAttributesCommand, type Message, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { ExponentialBackoff } from '../../../src/business/shared/policy/exponential-backoff';
import type { TxRepositories } from '../../../src/business/wagering/port/tx-repositories.port';
import { ProcessWagerTransaction } from '../../../src/business/wagering/use-case/process-wager-transaction/process-wager-transaction';
import { SystemClock } from '../../../src/infrastructure/clock/system-clock';
import { DEFAULT_SQS_CONSUMER_CONFIG, type SqsConsumerConfig } from '../../../src/infrastructure/config/sqs-consumer-config';
import { Sha256PayloadHasher } from '../../../src/infrastructure/hashing/sha256-payload-hasher';
import { UuidV7IdGenerator } from '../../../src/infrastructure/id/uuid-v7-id-generator';
import { DEAD_LETTER_ATTRIBUTES, type SqsConsumerLoop } from '../../../src/infrastructure/messaging/sqs/sqs-consumer-loop';
import { createTxRepositories } from '../../../src/infrastructure/persistence/mikro-orm/repository/wagering-repositories';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm/unit-of-work';
import type { CircuitState } from '../../../src/infrastructure/resilience/circuit-breaker';
import { createWagerCommandConsumer } from '../../../src/infrastructure/wagering/wager-command-consumer.factory';
import { WAGER_COMMAND_CONSUMER } from '../../../src/infrastructure/wagering/wager-command-handler';
import { postgresUrl, testInfraConfig } from '../../support/infra-config';
import { createTestQueues, type TestQueues } from '../../support/test-queues';
import { uuidv7 } from '../../support/uuid';
import { countRows, createRealWageringApp, createWageringDatabase, type WageringDatabase } from '../persistence/wagering-orm';

const PROCESS_SCRIPT = new URL('./wager-command-consumer-process.ts', import.meta.url).pathname;
const LOCK_TIMEOUT_MS = 2_000;
const REFERENCE_BACKOFF = { baseMs: 2_000, capMs: 60_000, maxAttempts: 4 };

const consumerConfig = (overrides: Partial<SqsConsumerConfig> = {}): SqsConsumerConfig => ({
  ...DEFAULT_SQS_CONSUMER_CONFIG,
  waitTimeSeconds: 1,
  visibilityTimeoutSeconds: 5,
  heartbeatIntervalMs: 1_000,
  maxInProcessAttempts: 3,
  retry: { baseMs: 200, capMs: 400 },
  errorDelayMs: 50,
  shutdownTimeoutMs: 5_000,
  circuitBreaker: { failureThreshold: 1, openMs: 300 },
  ...overrides,
});

const until = async (condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

const lines = (stream: ReadableStream<Uint8Array>) => {
  const events: Array<Record<string, unknown>> = [];
  void (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('{')) events.push(JSON.parse(line) as Record<string, unknown>);
        newline = buffer.indexOf('\n');
      }
    }
  })();
  return events;
};

interface Wallet {
  readonly id: string;
  readonly playerId: string;
}

const commandOf = (wallet: Wallet, data: Record<string, unknown> = {}, messageId = `msg-${uuidv7()}`) => {
  const externalTransactionId = (data.externalTransactionId as string | undefined) ?? `tx-${uuidv7()}`;
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...data,
    },
  };
};

describe('wager commands over SQS against PostgreSQL and LocalStack', () => {
  let db: WageringDatabase;
  let queues: TestQueues;
  const wallets = new Set<string>();
  const consumers: SqsConsumerLoop[] = [];
  const children: Array<{ kill(signal?: number | NodeJS.Signals): void }> = [];

  beforeAll(async () => {
    db = await createWageringDatabase();
  });

  beforeEach(async () => {
    queues = await createTestQueues({ maxReceiveCount: 100, visibilityTimeoutSeconds: 5 });
  });

  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((consumer) => consumer.stop(2_000)));
    for (const child of children.splice(0)) child.kill('SIGKILL');
    await queues?.destroy();
    await db.assertConsistent(wallets);
  });

  afterAll(() => db?.close());

  const open = async (balance = '100.00'): Promise<Wallet> => {
    const wallet = await createRealWageringApp(db.orm).createWallet.execute({
      playerId: uuidv7(),
      initialBalance: { amount: balance, currency: 'BRL' },
    });
    wallets.add(wallet.id);
    return wallet;
  };

  /** O caminho HTTP: o mesmo use case com o hasher de produção, então os dois canais fazem o hash do mesmo jeito. */
  const http = () =>
    new ProcessWagerTransaction(
      new MikroOrmUnitOfWork<TxRepositories>(db.orm.em, (em) => createTxRepositories(em, { clock: new SystemClock() }), {
        lockTimeoutMs: LOCK_TIMEOUT_MS,
      }),
      new Sha256PayloadHasher(),
      new SystemClock(),
      new UuidV7IdGenerator(),
      new ExponentialBackoff({ ...REFERENCE_BACKOFF, random: Math.random }),
    );

  const consumer = (
    options: { readonly config?: Partial<SqsConsumerConfig>; readonly onCircuitStateChange?: (state: CircuitState) => void } = {},
  ) => {
    const loop = createWagerCommandConsumer({
      em: db.orm.em,
      client: queues.client,
      sqs: { commandsQueue: { url: queues.commands.url }, commandsDeadLetterQueue: { url: queues.commands.dlqUrl } },
      config: consumerConfig(options.config),
      referenceBackoff: REFERENCE_BACKOFF,
      lockTimeoutMs: LOCK_TIMEOUT_MS,
      ...(options.onCircuitStateChange === undefined ? {} : { onCircuitStateChange: options.onCircuitStateChange }),
    });
    consumers.push(loop);
    return loop;
  };

  const send = async (body: unknown, groupId: string): Promise<string> => {
    const { MessageId } = await queues.client.send(
      new SendMessageCommand({
        QueueUrl: queues.commands.url,
        MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
        MessageGroupId: groupId,
        MessageDeduplicationId: uuidv7(),
      }),
    );
    return MessageId ?? '';
  };

  const drained = async (): Promise<boolean> => {
    const { Attributes = {} } = await queues.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queues.commands.url,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return Attributes.ApproximateNumberOfMessages === '0' && Attributes.ApproximateNumberOfMessagesNotVisible === '0';
  };

  const deadLetters = async (waitTimeSeconds = 0): Promise<Message[]> =>
    (
      await queues.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.commands.dlqUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: waitTimeSeconds,
          MessageAttributeNames: ['All'],
        }),
      )
    ).Messages ?? [];

  const balanceOf = async (wallet: Wallet): Promise<string> =>
    ((await db.sql.query('SELECT balance FROM wallets WHERE id = $1', [wallet.id])).rows[0] as { balance: string }).balance;
  const bets = (wallet: Wallet) => countRows(db.sql, 'wager_transactions', "wallet_id = $1 AND kind = 'BET'", [wallet.id]);
  const debits = (wallet: Wallet) => countRows(db.sql, 'wallet_ledger_entries', "wallet_id = $1 AND direction = 'DEBIT'", [wallet.id]);
  const inboxProcessed = (messageId: string) =>
    countRows(db.sql, 'inbox_messages', 'consumer_name = $1 AND message_id = $2 AND processed_at IS NOT NULL', [
      WAGER_COMMAND_CONSUMER,
      messageId,
    ]);

  it('the same transaction via HTTP and via SQS has a single effect', async () => {
    const wallet = await open();
    const command = commandOf(wallet);
    const viaHttp = await http().execute({
      actor: { providerId: 'provider-a' },
      idempotencyKey: command.data.idempotencyKey,
      payload: command.data,
      source: { channel: 'HTTP' },
    });
    expect(viaHttp).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });

    await send(command, wallet.id);
    consumer().start();
    await until(drained, 15_000, 'the SQS command to be acked');

    expect(await bets(wallet)).toBe(1);
    expect(await debits(wallet)).toBe(1);
    expect(await balanceOf(wallet)).toBe('75.00');
    expect(await inboxProcessed(command.messageId)).toBe(1);
    expect(await deadLetters()).toEqual([]);
  });

  it('a redelivery of the same messageId is deduplicated by the inbox', async () => {
    const wallet = await open();
    const command = commandOf(wallet);
    await send(command, wallet.id);
    await send(command, wallet.id);

    consumer().start();
    await until(drained, 15_000, 'both deliveries to be acked');

    expect(await bets(wallet)).toBe(1);
    expect(await debits(wallet)).toBe(1);
    expect(await balanceOf(wallet)).toBe('75.00');
    expect(await countRows(db.sql, 'inbox_messages', 'message_id = $1', [command.messageId])).toBe(1);
    expect(await deadLetters()).toEqual([]);
  });

  it('a crash between the commit and the ack: the message comes back, is replayed and acked, with one debit', async () => {
    const wallet = await open();
    const command = commandOf(wallet);
    await send(command, wallet.id);
    const { endpoint, region, accessKeyId, secretAccessKey } = testInfraConfig().sqs;
    const child = Bun.spawn([process.execPath, 'run', PROCESS_SCRIPT], {
      env: {
        ...process.env,
        DATABASE_URL: db.database.url,
        SQS_ENDPOINT: endpoint,
        AWS_REGION: region,
        AWS_ACCESS_KEY_ID: accessKeyId,
        AWS_SECRET_ACCESS_KEY: secretAccessKey,
        SQS_COMMANDS_QUEUE_URL: queues.commands.url,
        SQS_COMMANDS_DLQ_URL: queues.commands.dlqUrl,
        SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
        SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '2',
        SQS_CONSUMER_HEARTBEAT_INTERVAL_MS: '500',
        FAULT_INJECTION: 'crash_after_commit_before_ack',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.push(child);
    const events = lines(child.stdout);

    await child.exited;
    expect(child.signalCode).toBe('SIGKILL');
    expect(events.filter((event) => event.event === 'processed')).toEqual([
      expect.objectContaining({ status: 'PROCESSED', idempotentReplay: false }),
    ]);
    expect(await debits(wallet)).toBe(1);
    expect(await inboxProcessed(command.messageId)).toBe(1);

    const replays: unknown[] = [];
    const loop = createWagerCommandConsumer({
      em: db.orm.em,
      client: queues.client,
      sqs: { commandsQueue: { url: queues.commands.url }, commandsDeadLetterQueue: { url: queues.commands.dlqUrl } },
      config: consumerConfig(),
      referenceBackoff: REFERENCE_BACKOFF,
      lockTimeoutMs: LOCK_TIMEOUT_MS,
      handler: { onProcessed: (output, message) => replays.push({ ...output, receiveCount: message.receiveCount }) },
    });
    consumers.push(loop);
    loop.start();
    await until(() => replays.length === 1, 15_000, 'the redelivery');
    await until(drained, 5_000, 'the ack of the redelivery');

    expect(replays).toEqual([expect.objectContaining({ status: 'PROCESSED', idempotentReplay: true, receiveCount: 2 })]);
    expect(await bets(wallet)).toBe(1);
    expect(await debits(wallet)).toBe(1);
    expect(await balanceOf(wallet)).toBe('75.00');
  });

  it('OPENING and a malformed command go to the DLQ with their reason, and persist nothing', async () => {
    const wallet = await open();
    const opening = commandOf(wallet, { kind: 'OPENING' });
    const malformed = { ...commandOf(wallet), data: { providerId: 'provider-a' } };
    const ids = [await send(opening, wallet.id), await send(malformed, uuidv7()), await send('{not json', uuidv7())];

    consumer().start();
    const dead: Message[] = [];
    await until(
      async () => {
        dead.push(...(await deadLetters(1)));
        return dead.length === 3;
      },
      15_000,
      'three dead letters',
    );

    const reasonOf = (id: string) =>
      dead.find((message) => message.MessageAttributes?.[DEAD_LETTER_ATTRIBUTES.sourceMessageId]?.StringValue === id)
        ?.MessageAttributes?.[DEAD_LETTER_ATTRIBUTES.reason]?.StringValue;
    expect(ids.map(reasonOf)).toEqual(['contract_violation', 'invalid_schema', 'invalid_json']);
    expect(await bets(wallet)).toBe(0);
    expect(await countRows(db.sql, 'inbox_messages', 'message_id = ANY($1)', [[opening.messageId, malformed.messageId]])).toBe(0);
    await until(drained, 5_000, 'the commands queue to drain');
  });

  it('WALLET_NOT_FOUND is acked without persisting anything', async () => {
    const ghost = { id: uuidv7(), playerId: uuidv7() };
    const command = commandOf(ghost);
    await send(command, ghost.id);

    consumer().start();
    await until(drained, 15_000, 'the ack');

    expect(await countRows(db.sql, 'wager_transactions', 'wallet_id = $1', [ghost.id])).toBe(0);
    expect(await countRows(db.sql, 'inbox_messages', 'message_id = $1', [command.messageId])).toBe(0);
    expect(await deadLetters()).toEqual([]);
  });

  it('with PostgreSQL down the breaker opens and nothing reaches the DLQ; once it is back the command is processed', async () => {
    const wallet = await open();
    const command = commandOf(wallet);
    const states: CircuitState[] = [];
    const loop = consumer({ onCircuitStateChange: (state) => states.push(state) });
    const { name } = db.database;
    const admin = new Client({ connectionString: postgresUrl(testInfraConfig(), testInfraConfig().postgres.adminDatabase) });
    await admin.connect();
    const assertionsPid = ((await db.sql.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid;
    const killOthers = () =>
      admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid() AND pid <> $2',
        [name, assertionsPid],
      );

    await admin.query(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS false`);
    let killing = true;
    const killer = (async () => {
      while (killing) {
        await killOthers();
        await Bun.sleep(20);
      }
    })();
    try {
      await killOthers();
      await send(command, wallet.id);
      loop.start();
      await until(() => states.includes('open'), 10_000, 'the breaker to open');
      await Bun.sleep(1_500);
      expect(await bets(wallet)).toBe(0);
      expect(await deadLetters()).toEqual([]);
    } finally {
      killing = false;
      await killer;
      await admin.query(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS true`);
      await admin.end();
    }

    await until(drained, 20_000, 'the command once PostgreSQL is back');
    expect(states.at(-1)).toBe('closed');
    expect(await debits(wallet)).toBe(1);
    expect(await balanceOf(wallet)).toBe('75.00');
    expect(await inboxProcessed(command.messageId)).toBe(1);
    expect(await deadLetters(1)).toEqual([]);
  });
});
