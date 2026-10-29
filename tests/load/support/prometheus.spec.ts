import { describe, expect, it } from 'bun:test';
import { deltaSamples, histogram, histogramQuantile, parseExposition, sumSamples, total } from './prometheus';

const scrape = (lockTimeouts: number, buckets: readonly number[]) => `# HELP lock_conflicts_total x
# TYPE lock_conflicts_total counter
lock_conflicts_total{type="lock_timeout"} ${lockTimeouts}
lock_conflicts_total{type="deadlock"} 0
lock_wait_seconds_bucket{le="0.01"} ${buckets[0]}
lock_wait_seconds_bucket{le="0.1"} ${buckets[1]}
lock_wait_seconds_bucket{le="+Inf"} ${buckets[2]}
lock_wait_seconds_sum 1.5
lock_wait_seconds_count ${buckets[2]}
`;

describe('prometheus helpers', () => {
  it('sums the replicas and subtracts the scrape taken before the scenario', () => {
    const before = sumSamples([parseExposition(scrape(1, [5, 5, 5])), parseExposition(scrape(0, [5, 5, 5]))]);
    const after = sumSamples([parseExposition(scrape(3, [10, 50, 60])), parseExposition(scrape(2, [10, 30, 40]))]);
    const delta = deltaSamples(before, after);

    expect(total(delta, 'lock_conflicts_total', 'type="lock_timeout"')).toBe(4);
    expect(total(delta, 'lock_conflicts_total', 'type="deadlock"')).toBe(0);
    expect(histogram(delta, 'lock_wait_seconds').count).toBe(90);
  });

  it('interpolates a quantile inside its bucket, like histogram_quantile', () => {
    const buckets: [number, number][] = [
      [0.01, 50],
      [0.1, 100],
      [Number.POSITIVE_INFINITY, 100],
    ];

    expect(histogramQuantile(buckets, 0.5)).toBeCloseTo(0.01);
    expect(histogramQuantile(buckets, 0.75)).toBeCloseTo(0.055);
    expect(histogramQuantile(buckets, 1)).toBeCloseTo(0.1);
  });

  it('answers the last finite bound when the quantile falls in +Inf, and NaN without samples', () => {
    expect(histogramQuantile([[0.1, 1], [Number.POSITIVE_INFINITY, 10]], 0.99)).toBe(0.1);
    expect(histogramQuantile([[0.1, 0], [Number.POSITIVE_INFINITY, 0]], 0.5)).toBeNaN();
  });
});
