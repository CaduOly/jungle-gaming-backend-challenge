import { describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../tests/support/fakes/fake-clock';
import { CircuitBreaker, type CircuitState } from './circuit-breaker';

const aBreaker = () => {
  const clock = new FakeClock();
  const changes: CircuitState[] = [];
  const breaker = new CircuitBreaker({
    failureThreshold: 2,
    openMs: 1_000,
    clock,
    onStateChange: (state) => changes.push(state),
  });
  return { clock, breaker, changes };
};

describe('CircuitBreaker', () => {
  it('starts closed and opens after the failure threshold', () => {
    const { breaker } = aBreaker();
    expect(breaker.state).toBe('closed');
    breaker.recordFailure();
    expect(breaker.canAttempt()).toBe(true);
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.isOpen).toBe(true);
    expect(breaker.canAttempt()).toBe(false);
  });

  it('resets the consecutive count on success', () => {
    const { breaker } = aBreaker();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
  });

  it('turns half-open after openMs and closes on a successful trial', () => {
    const { breaker, clock, changes } = aBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    clock.advance(400);
    expect(breaker.remainingOpenMs()).toBe(600);
    clock.advance(600);
    expect(breaker.state).toBe('half-open');
    expect(breaker.isOpen).toBe(true);
    expect(breaker.canAttempt()).toBe(true);
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(changes).toEqual(['open', 'half-open', 'closed']);
  });

  it('reopens on a failed half-open trial, for another full openMs', () => {
    const { breaker, clock } = aBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    clock.advance(1_000);
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.remainingOpenMs()).toBe(1_000);
  });

  it('rejects invalid options', () => {
    const clock = new FakeClock();
    expect(() => new CircuitBreaker({ failureThreshold: 0, openMs: 1, clock })).toThrow('failureThreshold');
    expect(() => new CircuitBreaker({ failureThreshold: 1, openMs: 0, clock })).toThrow('openMs');
  });
});
