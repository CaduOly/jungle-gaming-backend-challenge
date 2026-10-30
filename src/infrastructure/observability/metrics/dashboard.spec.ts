import { describe, expect, it } from 'bun:test';
import { METRIC_NAMES, WageringMetrics } from './wagering-metrics';

const ROOT = `${import.meta.dir}/../../../..`;
const SERIES_SUFFIX = /_(bucket|sum|count)$/;
/** Labels que o Prometheus ou os histograms adicionam sozinhos. */
const IMPLICIT_LABELS = new Set(['le', 'instance', 'job']);

interface Target {
  readonly expr: string;
  readonly datasource: { readonly uid: string };
}
interface Panel {
  readonly title: string;
  readonly targets: readonly Target[];
}
interface Dashboard {
  readonly uid: string;
  readonly panels: readonly Panel[];
}

const dashboard = (await Bun.file(`${ROOT}/infra/grafana/dashboards/wagering.json`).json()) as Dashboard;
const datasources = Bun.YAML.parse(await Bun.file(`${ROOT}/infra/grafana/provisioning/datasources/prometheus.yml`).text()) as {
  datasources: { uid: string; url: string }[];
};
const prometheus = Bun.YAML.parse(await Bun.file(`${ROOT}/infra/prometheus/prometheus.yml`).text()) as {
  scrape_configs: { job_name: string; metrics_path: string; dns_sd_configs: { names: string[]; port: number }[] }[];
};

const metricsOf = (expr: string): string[] =>
  [...expr.matchAll(/\b([a-z_][a-z0-9_]*)\s*[{[]/g)].map((match) => match[1] ?? '').filter((name) => name !== 'up');

const groupingLabelsOf = (expr: string): string[] =>
  [...expr.matchAll(/\bby\s*\(([^)]*)\)/g)].flatMap((match) => (match[1] ?? '').split(',').map((label) => label.trim()));

const registered = async (): Promise<Map<string, { type: string; labels: Set<string> }>> => {
  const metrics = new WageringMetrics();
  const found = new Map<string, { type: string; labels: Set<string> }>();
  for (const { name, type } of await metrics.registry.getMetricsAsJSON()) {
    const metric = metrics.registry.getSingleMetric(name) as unknown as { labelNames: string[] };
    found.set(name, { type: String(type), labels: new Set(metric.labelNames) });
  }
  return found;
};

describe('Grafana dashboard and Prometheus scrape', () => {
  const targets = dashboard.panels.flatMap((panel) => panel.targets.map((target) => ({ panel: panel.title, ...target })));

  it('queries only metrics the service registers, with their real suffixes and labels', async () => {
    const metrics = await registered();
    for (const target of targets) {
      const names = metricsOf(target.expr);
      expect({ panel: target.panel, hasMetric: names.length > 0 || target.expr.includes('up{') }).toEqual({
        panel: target.panel,
        hasMetric: true,
      });
      for (const series of names) {
        const base = series.replace(SERIES_SUFFIX, '');
        const metric = metrics.get(base);
        expect({ panel: target.panel, series, registered: metric !== undefined }).toEqual({
          panel: target.panel,
          series,
          registered: true,
        });
        if (series !== base) expect({ series, type: metric?.type }).toEqual({ series, type: 'histogram' });
        for (const label of groupingLabelsOf(target.expr)) {
          if (IMPLICIT_LABELS.has(label)) continue;
          expect({ series, label, known: metric?.labels.has(label) }).toEqual({ series, label, known: true });
        }
      }
    }
  });

  it('has a panel for every metric of the service', () => {
    const queried = new Set(targets.flatMap((target) => metricsOf(target.expr).map((name) => name.replace(SERIES_SUFFIX, ''))));
    expect(METRIC_NAMES.filter((name) => !queried.has(name))).toEqual([]);
  });

  it('reads every panel from the provisioned Prometheus datasource', () => {
    const uids = new Set(datasources.datasources.map((source) => source.uid));
    expect(dashboard.uid).toBe('jungle-wagering');
    expect(targets.filter((target) => !uids.has(target.datasource.uid))).toEqual([]);
    expect(datasources.datasources[0]?.url).toBe('http://prometheus:9090');
  });

  it('scrapes /metrics of every replica of the app service', () => {
    const job = prometheus.scrape_configs.find((config) => config.job_name === 'wagering');
    expect(job?.metrics_path).toBe('/metrics');
    expect(job?.dns_sd_configs[0]).toMatchObject({ names: ['app'], port: 3000 });
  });

  it('registers exactly the documented metrics', async () => {
    expect([...(await registered()).keys()].sort()).toEqual([...METRIC_NAMES].sort());
  });
});
