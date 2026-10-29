import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureInfraUp } from '../support/ensure-infra-up';
import { testInfraConfig } from '../support/infra-config';
import { createTestDatabase } from '../support/test-database';
import { createTestQueues } from '../support/test-queues';
import { uniqueSuffix } from '../support/uuid';
import { DatabaseProbe } from './support/database-probe';
import { K6_IMAGE, runK6, type HttpScenario } from './support/k6';
import { LoadStack } from './support/load-stack';
import { deltaSamples, histogram, total, type Samples } from './support/prometheus';
import { sampleUsage, scrapeReplicas } from './support/replica-metrics';
import { renderMarkdown, type Environment, type LoadReport, type ScenarioReport, type ServerSide } from './support/report';
import { run } from './support/shell';
import { runSqsPath } from './support/sqs-path';
import { reconcile, seedWallets, type SeededWallet } from './support/wagering-api';

const ROOT = resolve(import.meta.dir, '../..');
const INFRA_CONTAINERS = ['jungle-wagering-postgres-1', 'jungle-wagering-localstack-1'];

const env = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
};

const CONFIG = {
  durationSeconds: env('LOAD_DURATION_SECONDS', 60),
  warmupSeconds: env('LOAD_WARMUP_SECONDS', 15),
  warmupRate: env('LOAD_WARMUP_RATE', 20),
  rateDistributed: env('LOAD_RATE_DISTRIBUTED', 300),
  rateHot: env('LOAD_RATE_HOT', 100),
  rateMix: env('LOAD_RATE_MIX', 300),
  rateSqs: env('LOAD_RATE_SQS', 100),
  walletsDistributed: env('LOAD_WALLETS_DISTRIBUTED', 1000),
  walletsMix: env('LOAD_WALLETS_MIX', 200),
  walletsSqs: env('LOAD_WALLETS_SQS', 100),
  maxVus: env('LOAD_MAX_VUS', 400),
  k6Cpus: process.env.LOAD_K6_CPUS ?? '2',
};

const SCENARIOS = (process.env.LOAD_SCENARIOS ?? 'distributed,hot,mix,sqs').split(',').map((name) => name.trim());

const log = (message: string) => console.log(`[load] ${message}`);

const queueName = (url: string): string => url.slice(url.lastIndexOf('/') + 1);

const describeEnvironment = async (probe: DatabaseProbe, stack: LoadStack): Promise<Environment> => {
  const [app] = await stack.appContainers();
  const inspect = async (container: string, format: string) =>
    (await run(['docker', 'inspect', '--format', format, container], { allowFailure: true })).stdout.trim();
  const imageOf = (container: string) => inspect(container, '{{.Config.Image}}');
  const nginx = await stack.nginxContainer();
  const nanoCpus = app === undefined ? '' : await inspect(app, '{{.HostConfig.NanoCpus}}');
  const memory = app === undefined ? '' : await inspect(app, '{{.HostConfig.Memory}}');
  const nginxCpus = await inspect(nginx, '{{.HostConfig.NanoCpus}}');
  const bunVersion = app === undefined ? '' : (await run(['docker', 'exec', app, 'bun', '--version'])).stdout.trim();
  return {
    host: {
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      memoryGiB: Math.round(totalmem() / 1024 ** 3),
      kernel: release(),
    },
    versions: {
      docker: (await run(['docker', 'version', '--format', '{{.Server.Version}}'])).stdout.trim(),
      'docker compose': (await run(['docker', 'compose', 'version', '--short'])).stdout.trim(),
      bun: bunVersion,
      PostgreSQL: await probe.serverVersion(),
      LocalStack: await imageOf('jungle-wagering-localstack-1'),
      nginx: await imageOf(nginx),
      k6: K6_IMAGE,
    },
    limits: {
      'réplicas da app': `${(await stack.appContainers()).length} × ${Number.parseInt(nanoCpus, 10) / 1e9} CPU / ${Number.parseInt(memory, 10) / 1024 ** 2} MiB`,
      nginx: `${Number.parseInt(nginxCpus, 10) / 1e9} CPU`,
      k6: `${CONFIG.k6Cpus} CPU`,
      'PostgreSQL e LocalStack': 'sem limite (stack compartilhado)',
    },
  };
};

const serverSide = async (
  before: Samples,
  after: Samples,
  probe: DatabaseProbe,
  window: { from: Date; to: Date },
  unpublishedAfterDrain: number,
  usage: ServerSide['usage'],
): Promise<ServerSide> => {
  const delta = deltaSamples(before, after);
  const decided: Record<string, number> = {};
  for (const [key, value] of delta) {
    const match = /^wager_transactions_total\{(.*)\}$/.exec(key);
    if (match === null || value === 0) continue;
    const status = /status="([^"]+)"/.exec(match[1] ?? '')?.[1] ?? '?';
    decided[status] = (decided[status] ?? 0) + value;
  }
  return {
    lockWait: histogram(delta, 'lock_wait_seconds'),
    lockTimeouts: total(delta, 'lock_conflicts_total', 'type="lock_timeout"'),
    deadlocks: total(delta, 'lock_conflicts_total', 'type="deadlock"'),
    idempotentReplays: total(delta, 'idempotent_duplicates_total'),
    decided,
    outboxLagMetric: histogram(delta, 'outbox_lag_seconds'),
    outboxLagSql: await probe.outboxLag(window.from, window.to),
    unpublishedAfterDrain,
    usage,
  };
};

const main = async () => {
  const startedAt = new Date();
  await ensureInfraUp();
  const infra = testInfraConfig();
  const suffix = uniqueSuffix();
  const project = `jungle-load-${suffix.slice(-12)}`;
  const outDir = join(ROOT, 'tests/load/results', startedAt.toISOString().replaceAll(':', '-'));
  await mkdir(outDir, { recursive: true });

  const database = await createTestDatabase(infra);
  const queues = await createTestQueues({ maxReceiveCount: 100 }, infra);
  const containerDatabaseUrl = `postgres://${infra.postgres.user}:${infra.postgres.password}@postgres:5432/${database.name}`;
  const stack = LoadStack.create({
    root: ROOT,
    project,
    databaseUrl: containerDatabaseUrl,
    commandsQueue: queueName(queues.commands.url),
    commandsDlq: queueName(queues.commands.dlqUrl),
    eventsQueue: queueName(queues.events.url),
  });
  log(`project ${project}, database ${database.name}, queues *-${queues.suffix}.fifo`);

  let probe: DatabaseProbe | undefined;
  const cleanup = async () => {
    await probe?.close().catch(() => undefined);
    if (process.env.KEEP_LOAD_STACK === '1') {
      log(`KEEP_LOAD_STACK=1: leaving ${project}, ${database.name} and the queues up`);
      return;
    }
    await stack.down().catch((error) => console.error(error));
    await queues.destroy().catch((error) => console.error(error));
    await database.drop().catch((error) => console.error(error));
  };
  process.once('SIGINT', () => void cleanup().finally(() => process.exit(130)));

  try {
    await stack.up();
    probe = await DatabaseProbe.connect(database.url);
    const baseUrl = await stack.baseUrl();
    const replicas = await stack.appContainers();
    const nginx = await stack.nginxContainer();
    const watched = [...replicas, nginx, ...INFRA_CONTAINERS];
    log(`nginx at ${baseUrl}, ${replicas.length} replicas`);

    const environment = await describeEnvironment(probe, stack);
    const allWallets: SeededWallet[] = [];
    const seed = async (count: number, name: string): Promise<string> => {
      const wallets = await seedWallets(baseUrl, count);
      allWallets.push(...wallets);
      const file = join(outDir, `wallets-${name}.json`);
      await writeFile(file, JSON.stringify(wallets));
      return file;
    };

    const scenarios: ScenarioReport[] = [];
    const httpScenario = async (scenario: HttpScenario, title: string, rate: number, walletsFile: string) => {
      log(`${scenario}: ${CONFIG.warmupSeconds}s warm-up at ${CONFIG.warmupRate}/s, ${CONFIG.durationSeconds}s at ${rate}/s`);
      const before = await scrapeReplicas(replicas);
      const from = new Date(Date.now() + CONFIG.warmupSeconds * 1000);
      const usage = sampleUsage(watched);
      const http = await runK6({
        root: ROOT,
        network: stack.network,
        outDir,
        scenario,
        walletsFile,
        rate,
        durationSeconds: CONFIG.durationSeconds,
        warmupRate: CONFIG.warmupRate,
        warmupSeconds: CONFIG.warmupSeconds,
        maxVus: CONFIG.maxVus,
        cpus: CONFIG.k6Cpus,
      });
      const to = new Date();
      const containerUsage = await usage.stop();
      const unpublished = await probe!.waitOutboxDrained(120_000);
      const after = await scrapeReplicas(replicas);
      scenarios.push({
        name: title,
        http,
        server: await serverSide(before, after, probe!, { from, to }, unpublished, containerUsage),
      });
      log(`${scenario}: ${http.requests} requests, p95 ${http.latencyMs.p95} ms, p99 ${http.latencyMs.p99} ms`);
    };

    if (SCENARIOS.includes('distributed')) {
      const file = await seed(CONFIG.walletsDistributed, 'distributed');
      await httpScenario('distributed', `Distribuído (${CONFIG.walletsDistributed} wallets)`, CONFIG.rateDistributed, file);
    }
    if (SCENARIOS.includes('hot')) {
      const file = await seed(1, 'hot');
      await httpScenario('hot', 'Hot wallet (1 wallet)', CONFIG.rateHot, file);
    }
    if (SCENARIOS.includes('mix')) {
      const file = await seed(CONFIG.walletsMix, 'mix');
      await httpScenario('mix', `Mix com replays e conflitos (${CONFIG.walletsMix} wallets)`, CONFIG.rateMix, file);
    }
    if (SCENARIOS.includes('sqs')) {
      const wallets = await seedWallets(baseUrl, CONFIG.walletsSqs);
      allWallets.push(...wallets);
      log(`sqs: ${CONFIG.warmupSeconds}s warm-up at ${CONFIG.warmupRate}/s, ${CONFIG.durationSeconds}s at ${CONFIG.rateSqs}/s`);
      const before = await scrapeReplicas(replicas);
      const usage = sampleUsage(watched);
      const sqs = await runSqsPath({
        client: queues.client,
        queueUrl: queues.commands.url,
        probe,
        wallets,
        warmupRate: CONFIG.warmupRate,
        warmupSeconds: CONFIG.warmupSeconds,
        rate: CONFIG.rateSqs,
        durationSeconds: CONFIG.durationSeconds,
        drainTimeoutMs: 180_000,
      });
      const containerUsage = await usage.stop();
      const unpublished = await probe.waitOutboxDrained(120_000);
      const after = await scrapeReplicas(replicas);
      scenarios.push({
        name: `Caminho SQS (${CONFIG.walletsSqs} wallets, um MessageGroupId por wallet)`,
        sqs,
        server: await serverSide(before, after, probe, { from: sqs.startedAt, to: sqs.endedAt }, unpublished, containerUsage),
      });
      log(`sqs: ${sqs.applied}/${sqs.sent} applied, p95 ${sqs.latencyMs.p95} ms, p99 ${sqs.latencyMs.p99} ms`);
    }

    log(`reconciling ${allWallets.length} wallets`);
    const ids = allWallets.map((wallet) => wallet.id);
    const outcomes = await reconcile(baseUrl, ids);
    const sqlViolations = await probe.inconsistentWallets(ids);
    const report: LoadReport = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      environment,
      config: CONFIG,
      scenarios,
      reconciliation: {
        wallets: ids.length,
        consistent: outcomes.filter((outcome) => outcome.consistent).length,
        inconsistent: outcomes.filter((outcome) => !outcome.consistent).map((outcome) => outcome.walletId),
        sqlViolations: [...sqlViolations.values()].reduce((sum, violations) => sum + violations.length, 0),
      },
    };
    await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(outDir, 'report.md'), renderMarkdown(report));
    log(`report: ${join(outDir, 'report.md')}`);
    if (report.reconciliation.consistent !== report.reconciliation.wallets || report.reconciliation.sqlViolations > 0) {
      throw new Error(`reconciliation failed: ${report.reconciliation.inconsistent.length} wallets inconsistent`);
    }
  } finally {
    await cleanup();
  }
};

await main();
