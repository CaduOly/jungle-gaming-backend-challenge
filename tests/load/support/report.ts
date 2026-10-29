import type { OutboxLag } from './database-probe';
import type { HttpScenarioResult } from './k6';
import type { HistogramSummary } from './prometheus';
import type { ContainerUsage } from './replica-metrics';
import type { SqsPathResult } from './sqs-path';
import { round } from './stats';

export interface Environment {
  readonly host: { readonly cpu: string; readonly cores: number; readonly memoryGiB: number; readonly kernel: string };
  readonly versions: Record<string, string>;
  readonly limits: Record<string, string>;
}

export interface ServerSide {
  readonly lockWait: HistogramSummary;
  readonly lockTimeouts: number;
  readonly deadlocks: number;
  readonly idempotentReplays: number;
  readonly decided: Record<string, number>;
  readonly outboxLagMetric: HistogramSummary;
  readonly outboxLagSql: OutboxLag;
  readonly unpublishedAfterDrain: number;
  readonly usage: readonly ContainerUsage[];
}

export interface ScenarioReport {
  readonly name: string;
  readonly http?: HttpScenarioResult;
  readonly sqs?: SqsPathResult;
  readonly server: ServerSide;
}

export interface Reconciliation {
  readonly wallets: number;
  readonly consistent: number;
  readonly inconsistent: readonly string[];
  readonly sqlViolations: number;
}

export interface LoadReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly environment: Environment;
  readonly config: Record<string, number | string>;
  readonly scenarios: readonly ScenarioReport[];
  readonly reconciliation: Reconciliation;
}

const ms = (value: number): string => (Number.isNaN(value) ? '-' : `${round(value, 1)}`);
const seconds = (value: number): string => (Number.isNaN(value) ? '-' : `${round(value * 1000, 1)}`);
const average = (values: readonly number[]): number =>
  values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;

const table = (header: readonly string[], rows: readonly (readonly (string | number)[])[]): string =>
  [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join(
    '\n',
  );

const httpSection = (report: ScenarioReport, http: HttpScenarioResult): string => {
  const errors = Object.entries(http.statuses).filter(([key]) => !['fresh 200', 'replay 200', 'conflict 409'].includes(key));
  return [
    table(
      ['taxa ofertada (req/s)', 'requisições', 'throughput (req/s)', 'iterações descartadas', 'p50 (ms)', 'p95 (ms)', 'p99 (ms)', 'máx (ms)'],
      [
        [
          http.offeredRate,
          http.requests,
          round(http.throughput, 1),
          http.droppedIterations,
          ms(http.latencyMs.p50),
          ms(http.latencyMs.p95),
          ms(http.latencyMs.p99),
          ms(http.latencyMs.max),
        ],
      ],
    ),
    '',
    table(
      ['operação e status', 'requisições'],
      Object.entries(http.statuses).map(([key, value]) => [key, value]),
    ),
    '',
    `Respostas fora do esperado: ${errors.reduce((sum, [, value]) => sum + value, 0)}. Replays com resposta divergente: ${http.replayMismatches}.`,
    '',
    Object.keys(http.latencyByOpMs).length > 1
      ? table(
          ['operação', 'requisições', 'p50 (ms)', 'p95 (ms)', 'p99 (ms)'],
          Object.entries(http.latencyByOpMs).map(([op, value]) => [op, value.count, ms(value.p50), ms(value.p95), ms(value.p99)]),
        )
      : '',
    serverSection(report.server),
  ].join('\n');
};

const sqsSection = (report: ScenarioReport, sqs: SqsPathResult): string =>
  [
    table(
      ['taxa ofertada (cmd/s)', 'enviados', 'aplicados', 'faltando', 'throughput (cmd/s)', 'p50 (ms)', 'p95 (ms)', 'p99 (ms)', 'máx (ms)'],
      [
        [
          sqs.offeredRate,
          sqs.sent,
          sqs.applied,
          sqs.missing,
          round(sqs.throughput, 1),
          ms(sqs.latencyMs.p50),
          ms(sqs.latencyMs.p95),
          ms(sqs.latencyMs.p99),
          ms(sqs.latencyMs.max),
        ],
      ],
    ),
    '',
    `Status finais: ${Object.entries(sqs.statuses)
      .map(([status, value]) => `${status} ${value}`)
      .join(', ')}. Falhas de envio: ${sqs.sendFailures}.`,
    serverSection(report.server),
  ].join('\n');

const serverSection = (server: ServerSide): string =>
  [
    '',
    table(
      ['lock_wait (amostras)', 'lock_wait p50 (ms)', 'p95 (ms)', 'p99 (ms)', 'lock timeouts', 'deadlocks', 'replays (métrica)'],
      [
        [
          server.lockWait.count,
          seconds(server.lockWait.p50),
          seconds(server.lockWait.p95),
          seconds(server.lockWait.p99),
          server.lockTimeouts,
          server.deadlocks,
          server.idempotentReplays,
        ],
      ],
    ),
    '',
    table(
      ['outbox (eventos)', 'lag SQL p50 (ms)', 'p95 (ms)', 'p99 (ms)', 'máx (ms)', 'não publicados ao fim', 'lag métrica p95 (ms)'],
      [
        [
          server.outboxLagSql.events,
          ms(server.outboxLagSql.p50Ms),
          ms(server.outboxLagSql.p95Ms),
          ms(server.outboxLagSql.p99Ms),
          ms(server.outboxLagSql.maxMs),
          server.unpublishedAfterDrain,
          seconds(server.outboxLagMetric.p95),
        ],
      ],
    ),
    '',
    table(
      ['container', 'CPU média (%)', 'CPU pico (%)', 'RAM média (MiB)'],
      server.usage.map((usage) => [
        usage.name,
        round(average(usage.cpuPercent), 1),
        round(Math.max(...usage.cpuPercent), 1),
        round(average(usage.memoryMiB), 0),
      ]),
    ),
  ].join('\n');

export const renderMarkdown = (report: LoadReport): string =>
  [
    `# Resultado da carga (${report.startedAt})`,
    '',
    '## Ambiente',
    '',
    table(
      ['item', 'valor'],
      [
        ['CPU', `${report.environment.host.cpu} (${report.environment.host.cores} threads)`],
        ['RAM', `${report.environment.host.memoryGiB} GiB`],
        ['kernel', report.environment.host.kernel],
        ...Object.entries(report.environment.versions),
        ...Object.entries(report.environment.limits),
      ],
    ),
    '',
    '## Configuração',
    '',
    table(
      ['parâmetro', 'valor'],
      Object.entries(report.config).map(([key, value]) => [key, value]),
    ),
    ...report.scenarios.flatMap((scenario) => [
      '',
      `## ${scenario.name}`,
      '',
      scenario.http !== undefined ? httpSection(scenario, scenario.http) : '',
      scenario.sqs !== undefined ? sqsSection(scenario, scenario.sqs) : '',
    ]),
    '',
    '## Reconciliação',
    '',
    `${report.reconciliation.consistent} de ${report.reconciliation.wallets} wallets \`consistent: true\` pela API; ` +
      `${report.reconciliation.sqlViolations} violações na conferência SQL do ledger.`,
    ...(report.reconciliation.inconsistent.length > 0 ? ['', `Inconsistentes: ${report.reconciliation.inconsistent.join(', ')}`] : []),
    '',
  ].join('\n');
