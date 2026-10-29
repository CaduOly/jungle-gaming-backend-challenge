import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { DatabaseProbe } from './database-probe';
import { summarize, type LatencySummary } from './stats';
import { LOAD_PROVIDER, type SeededWallet } from './wagering-api';

export interface SqsPathOptions {
  readonly client: SQSClient;
  readonly queueUrl: string;
  readonly probe: DatabaseProbe;
  readonly wallets: readonly SeededWallet[];
  readonly warmupRate: number;
  readonly warmupSeconds: number;
  readonly rate: number;
  readonly durationSeconds: number;
  readonly drainTimeoutMs: number;
}

export interface SqsPathResult {
  readonly sent: number;
  readonly applied: number;
  readonly missing: number;
  readonly sendFailures: number;
  /** Commands of the measured phase per second, from the first send to the last apply. */
  readonly throughput: number;
  readonly offeredRate: number;
  readonly latencyMs: LatencySummary;
  readonly statuses: Record<string, number>;
  readonly startedAt: Date;
  readonly endedAt: Date;
}

const KINDS = ['BET', 'BET', 'BET', 'WIN', 'LOSS'] as const;

const commandFor = (wallet: SeededWallet, externalTransactionId: string) => ({
  messageId: `msg-${externalTransactionId}`,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: {
    providerId: LOAD_PROVIDER,
    externalTransactionId,
    idempotencyKey: `${LOAD_PROVIDER}:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${externalTransactionId}`,
    gameId: 'load-test',
    kind: KINDS[Math.floor(Math.random() * KINDS.length)],
    money: { amount: '1.00', currency: 'BRL' },
  },
});

interface Phase {
  readonly prefix: string;
  readonly sentAt: Map<string, number>;
  failures: number;
}

/** Sends `rate` commands per second for `seconds`, in batches of 10 every 1/(rate/10) s (an open model). */
const produce = async (options: SqsPathOptions, phase: Phase, rate: number, seconds: number): Promise<void> => {
  const total = rate * seconds;
  const batches = Math.ceil(total / 10);
  const intervalMs = 1000 / (rate / 10);
  const start = performance.now();
  const inFlight: Promise<void>[] = [];
  for (let batch = 0; batch < batches; batch++) {
    const wait = start + batch * intervalMs - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    const entries = Array.from({ length: Math.min(10, total - batch * 10) }, (_, index) => {
      const externalTransactionId = `${phase.prefix}${batch * 10 + index}`;
      const wallet = options.wallets[(batch * 10 + index) % options.wallets.length] as SeededWallet;
      const command = commandFor(wallet, externalTransactionId);
      return {
        externalTransactionId,
        entry: {
          Id: `${index}`,
          MessageBody: JSON.stringify(command),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: command.messageId,
        },
      };
    });
    inFlight.push(
      (async () => {
        const sentAt = Date.now();
        const result = await options.client.send(
          new SendMessageBatchCommand({ QueueUrl: options.queueUrl, Entries: entries.map(({ entry }) => entry) }),
        );
        phase.failures += result.Failed?.length ?? 0;
        const failed = new Set(result.Failed?.map((failure) => failure.Id));
        for (const { externalTransactionId, entry } of entries) {
          if (!failed.has(entry.Id)) phase.sentAt.set(externalTransactionId, sentAt);
        }
      })(),
    );
  }
  await Promise.all(inFlight);
};

const waitApplied = async (options: SqsPathOptions, phase: Phase): Promise<Map<string, number>> => {
  const ids = [...phase.sentAt.keys()];
  const deadline = Date.now() + options.drainTimeoutMs;
  let applied = await options.probe.appliedAt(LOAD_PROVIDER, ids);
  while (applied.size < ids.length && Date.now() < deadline) {
    await Bun.sleep(1_000);
    applied = await options.probe.appliedAt(LOAD_PROVIDER, ids);
  }
  return applied;
};

/**
 * The SQS path end to end: a producer on the host sends WagerTransactionRequested commands to the commands queue
 * and the latency is the time from the send to the transaction row being decided in PostgreSQL.
 */
export const runSqsPath = async (options: SqsPathOptions): Promise<SqsPathResult> => {
  const runId = Date.now().toString(36);
  const warmup: Phase = { prefix: `sqs-warmup-${runId}-`, sentAt: new Map(), failures: 0 };
  await produce(options, warmup, options.warmupRate, options.warmupSeconds);
  await waitApplied(options, warmup);

  const main: Phase = { prefix: `sqs-main-${runId}-`, sentAt: new Map(), failures: 0 };
  const startedAt = new Date();
  await produce(options, main, options.rate, options.durationSeconds);
  const applied = await waitApplied(options, main);
  const endedAt = new Date();

  const latencies: number[] = [];
  let firstSend = Number.POSITIVE_INFINITY;
  let lastApply = 0;
  for (const [id, sentAt] of main.sentAt) {
    firstSend = Math.min(firstSend, sentAt);
    const appliedAt = applied.get(id);
    if (appliedAt === undefined) continue;
    lastApply = Math.max(lastApply, appliedAt);
    latencies.push(appliedAt - sentAt);
  }
  return {
    sent: main.sentAt.size,
    applied: applied.size,
    missing: main.sentAt.size - applied.size,
    sendFailures: main.failures,
    throughput: applied.size / ((lastApply - firstSend) / 1000),
    offeredRate: options.rate,
    latencyMs: summarize(latencies),
    statuses: await options.probe.transactionStatuses(LOAD_PROVIDER, main.prefix),
    startedAt,
    endedAt,
  };
};
