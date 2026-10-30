/** Um scrape achatado em `name{labels}` -> valor, somado em todas as réplicas. */
export type Samples = ReadonlyMap<string, number>;

const SAMPLE_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/;

export const parseExposition = (text: string): Map<string, number> => {
  const samples = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const match = SAMPLE_LINE.exec(line.trim());
    if (match === null) continue;
    const [, name, labels = '', raw = ''] = match;
    const value = Number.parseFloat(raw);
    if (Number.isNaN(value)) continue;
    samples.set(`${name}${labels}`, value);
  }
  return samples;
};

export const sumSamples = (scrapes: readonly Samples[]): Map<string, number> => {
  const total = new Map<string, number>();
  for (const scrape of scrapes) {
    for (const [key, value] of scrape) total.set(key, (total.get(key) ?? 0) + value);
  }
  return total;
};

export const deltaSamples = (before: Samples, after: Samples): Map<string, number> => {
  const delta = new Map<string, number>();
  for (const [key, value] of after) delta.set(key, value - (before.get(key) ?? 0));
  return delta;
};

/** Soma de todas as séries de `name` cujos labels contêm todo o `match` (por exemplo `type="lock_timeout"`). */
export const total = (samples: Samples, name: string, ...match: readonly string[]): number => {
  let sum = 0;
  for (const [key, value] of samples) {
    const [series, labels = ''] = key.split('{');
    if (series !== name) continue;
    if (match.every((label) => labels.includes(label))) sum += value;
  }
  return sum;
};

export interface HistogramSummary {
  readonly count: number;
  readonly sumSeconds: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

/**
 * Quantil a partir de buckets cumulativos com interpolação linear dentro do bucket, a mesma estimativa do
 * histogram_quantile do PromQL. Acima do último bucket finito responde o limite desse bucket (o valor real é maior).
 */
export const histogramQuantile = (buckets: readonly (readonly [number, number])[], q: number): number => {
  const sorted = [...buckets].sort((a, b) => a[0] - b[0]);
  const count = sorted.at(-1)?.[1] ?? 0;
  if (count === 0) return Number.NaN;
  const rank = q * count;
  let previousBound = 0;
  let previousCount = 0;
  for (const [bound, cumulative] of sorted) {
    if (cumulative >= rank) {
      if (bound === Number.POSITIVE_INFINITY) return previousBound;
      const inBucket = cumulative - previousCount;
      return inBucket === 0 ? bound : previousBound + ((bound - previousBound) * (rank - previousCount)) / inBucket;
    }
    previousBound = bound;
    previousCount = cumulative;
  }
  return previousBound;
};

export const histogram = (samples: Samples, name: string): HistogramSummary => {
  const buckets: [number, number][] = [];
  for (const [key, value] of samples) {
    const match = new RegExp(`^${name}_bucket\\{.*le="([^"]+)"`).exec(key);
    if (match === null) continue;
    const bound = match[1] === '+Inf' ? Number.POSITIVE_INFINITY : Number.parseFloat(match[1] ?? '');
    const existing = buckets.find(([b]) => b === bound);
    if (existing === undefined) buckets.push([bound, value]);
    else existing[1] += value;
  }
  return {
    count: total(samples, `${name}_count`),
    sumSeconds: total(samples, `${name}_sum`),
    p50: histogramQuantile(buckets, 0.5),
    p95: histogramQuantile(buckets, 0.95),
    p99: histogramQuantile(buckets, 0.99),
  };
};
