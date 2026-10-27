import { describe, expect, it } from 'bun:test';
import { InvalidBackoffConfigurationError } from '../error/invalid-backoff-configuration-error';
import { ExponentialBackoff, MAX_BACKOFF_CAP_MS } from './exponential-backoff';

const backoff = (random: () => number) =>
  new ExponentialBackoff({ baseMs: 2_000, capMs: 60_000, maxAttempts: 8, random });

describe('ExponentialBackoff', () => {
  it('doubles the window per attempt up to the cap when jitter is at its maximum', () => {
    const policy = backoff(() => 0.999_999_999);
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => policy.nextDelayMs(attempt));
    expect(delays).toEqual([1_999, 3_999, 7_999, 15_999, 31_999, 59_999, 59_999, 59_999]);
  });

  it('never goes below half of the window when jitter is at its minimum', () => {
    const policy = backoff(() => 0);
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => policy.nextDelayMs(attempt));
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it('spreads the delay inside [window/2, window) according to the random source', () => {
    expect(backoff(() => 0.5).nextDelayMs(3)).toBe(6_000);
  });

  it('stays at the cap for very large attempt numbers', () => {
    expect(backoff(() => 0).nextDelayMs(10_000)).toBe(30_000);
  });

  it('never returns a zero delay, even with baseMs = 1', () => {
    const policy = new ExponentialBackoff({ baseMs: 1, capMs: 1, maxAttempts: 3, random: () => 0 });
    expect(policy.nextDelayMs(1)).toBe(1);
    expect(policy.nextDelayMs(50)).toBe(1);
  });

  it('accepts a cap of 24h and stays within it', () => {
    const policy = new ExponentialBackoff({
      baseMs: 1_000,
      capMs: MAX_BACKOFF_CAP_MS,
      maxAttempts: 3,
      random: () => 0.999_999_999,
    });
    expect(policy.nextDelayMs(1_000)).toBeLessThan(MAX_BACKOFF_CAP_MS);
  });

  it('reports exhaustion once the attempts reach the maximum', () => {
    const policy = backoff(() => 0);
    expect(policy.isExhausted(7)).toBe(false);
    expect(policy.isExhausted(8)).toBe(true);
    expect(policy.isExhausted(9)).toBe(true);
  });

  it('exposes the configured maximum of attempts', () => {
    expect(backoff(() => 0).maxAttempts).toBe(8);
  });

  it.each([0, -1, 1.5])('rejects attempt %p', (attempt) => {
    expect(() => backoff(() => 0).nextDelayMs(attempt)).toThrow(InvalidBackoffConfigurationError);
  });

  it.each([
    { baseMs: 0, capMs: 10, maxAttempts: 1 },
    { baseMs: 10, capMs: 5, maxAttempts: 1 },
    { baseMs: 10, capMs: 10, maxAttempts: 0 },
    { baseMs: 1.5, capMs: 10, maxAttempts: 1 },
    { baseMs: 10, capMs: MAX_BACKOFF_CAP_MS + 1, maxAttempts: 1 },
  ])('rejects invalid configuration %p', (options) => {
    expect(() => new ExponentialBackoff({ ...options, random: () => 0 })).toThrow(
      InvalidBackoffConfigurationError,
    );
  });

  it('rejects a random source outside [0, 1)', () => {
    expect(() => backoff(() => 1).nextDelayMs(1)).toThrow(InvalidBackoffConfigurationError);
    expect(() => backoff(() => -0.1).nextDelayMs(1)).toThrow(InvalidBackoffConfigurationError);
  });
});
