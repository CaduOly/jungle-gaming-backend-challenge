import type { MetricValueWithName } from 'prom-client';
import type { WageringMetrics } from './wagering-metrics';

/**
 * The current value of a counter or gauge series, or the observation count of a histogram series. 0 when the
 * series was never touched. Read by the specs and by nothing in production.
 */
export const metricValue = async (
  metrics: WageringMetrics,
  name: string,
  labels: Record<string, string> = {},
): Promise<number> => {
  const metric = metrics.registry.getSingleMetric(name);
  if (metric === undefined) throw new Error(`metric ${name} is not registered`);
  const values: MetricValueWithName<string>[] = (await metric.get()).values;
  const matches = (series: MetricValueWithName<string>) =>
    Object.entries(labels).every(([key, value]) => String(series.labels[key]) === value);
  const histogramCount = values.find((series) => series.metricName === `${name}_count` && matches(series));
  if (histogramCount !== undefined) return histogramCount.value;
  return values.filter((series) => series.metricName === undefined || series.metricName === name).find(matches)?.value ?? 0;
};
