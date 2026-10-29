import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LatencySummary } from './stats';
import { run } from './shell';

export const K6_IMAGE = 'grafana/k6:1.3.0';

export type HttpScenario = 'distributed' | 'hot' | 'mix';

export interface K6Options {
  readonly root: string;
  readonly network: string;
  readonly outDir: string;
  readonly scenario: HttpScenario;
  readonly walletsFile: string;
  readonly rate: number;
  readonly durationSeconds: number;
  readonly warmupRate: number;
  readonly warmupSeconds: number;
  readonly maxVus: number;
  readonly cpus: string;
}

export interface HttpScenarioResult {
  readonly scenario: HttpScenario;
  readonly offeredRate: number;
  readonly requests: number;
  readonly throughput: number;
  readonly droppedIterations: number;
  readonly latencyMs: Omit<LatencySummary, 'count'> & { readonly avg: number };
  readonly latencyByOpMs: Record<string, Omit<LatencySummary, 'count'> & { readonly count: number }>;
  /** `op status` -> requests, e.g. `fresh 200`, `conflict 409`. */
  readonly statuses: Record<string, number>;
  readonly replayMismatches: number;
}

interface TrendValues {
  readonly avg: number;
  readonly med: number;
  readonly 'p(95)': number;
  readonly 'p(99)': number;
  readonly max: number;
  readonly count?: number;
}

interface Summary {
  readonly metrics: Record<string, { readonly values: Record<string, number> } | undefined>;
}

const trend = (summary: Summary, name: string): TrendValues | undefined =>
  summary.metrics[name]?.values as TrendValues | undefined;

const count = (summary: Summary, name: string): number => summary.metrics[name]?.values.count ?? 0;

export const runK6 = async (options: K6Options): Promise<HttpScenarioResult> => {
  const out = join(options.outDir, options.scenario);
  await mkdir(out, { recursive: true });
  await chmod(out, 0o777);
  await run(
    [
      'docker',
      'run',
      '--rm',
      '--network',
      options.network,
      '--cpus',
      options.cpus,
      '-v',
      `${join(options.root, 'tests/load/k6')}:/scripts:ro`,
      '-v',
      `${options.walletsFile}:/data/wallets.json:ro`,
      '-v',
      `${out}:/out`,
      '-e',
      `SCENARIO=${options.scenario}`,
      '-e',
      `RATE=${options.rate}`,
      '-e',
      `DURATION=${options.durationSeconds}s`,
      '-e',
      `WARMUP_RATE=${options.warmupRate}`,
      '-e',
      `WARMUP=${options.warmupSeconds}s`,
      '-e',
      `MAX_VUS=${options.maxVus}`,
      K6_IMAGE,
      'run',
      '--quiet',
      '--no-color',
      '/scripts/wagering.js',
    ],
    { inherit: true },
  );
  const summary = (await Bun.file(join(out, 'summary.json')).json()) as Summary;
  const statuses: Record<string, number> = {};
  const latencyByOpMs: HttpScenarioResult['latencyByOpMs'] = {};
  for (const [name, metric] of Object.entries(summary.metrics)) {
    const byStatus = /^http_reqs\{scenario:main,op:(\w+),status:(\d+)\}$/.exec(name);
    if (byStatus !== null && (metric?.values.count ?? 0) > 0) statuses[`${byStatus[1]} ${byStatus[2]}`] = metric?.values.count ?? 0;
    const byOp = /^http_req_duration\{scenario:main,op:(\w+)\}$/.exec(name);
    const values = metric?.values as TrendValues | undefined;
    if (byOp !== null && values !== undefined && (values.count ?? 0) > 0) {
      latencyByOpMs[byOp[1] ?? ''] = { count: values.count ?? 0, p50: values.med, p95: values['p(95)'], p99: values['p(99)'], max: values.max };
    }
  }
  const main = trend(summary, 'http_req_duration{scenario:main}');
  const requests = count(summary, 'http_reqs{scenario:main}');
  return {
    scenario: options.scenario,
    offeredRate: options.rate,
    requests,
    throughput: requests / options.durationSeconds,
    droppedIterations: count(summary, 'dropped_iterations{scenario:main}'),
    latencyMs: {
      avg: main?.avg ?? Number.NaN,
      p50: main?.med ?? Number.NaN,
      p95: main?.['p(95)'] ?? Number.NaN,
      p99: main?.['p(99)'] ?? Number.NaN,
      max: main?.max ?? Number.NaN,
    },
    latencyByOpMs,
    statuses,
    replayMismatches: count(summary, 'replay_mismatches'),
  };
};
