import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { installGracefulShutdown } from './graceful-shutdown';

const setup = (shutdown: () => Promise<unknown>, timeoutMs = 1_000) => {
  const source = new EventEmitter();
  const exits: number[] = [];
  const errors: unknown[] = [];
  installGracefulShutdown(shutdown, {
    timeoutMs,
    source,
    exit: (code) => exits.push(code),
    onError: (error) => errors.push(error),
  });
  return { source, exits, errors };
};

describe('installGracefulShutdown', () => {
  it('runs the shutdown once on SIGTERM and exits 0', async () => {
    let calls = 0;
    const { source, exits } = setup(async () => {
      calls += 1;
    });
    source.emit('SIGTERM');
    source.emit('SIGINT');
    await Bun.sleep(5);
    expect(calls).toBe(1);
    expect(exits).toEqual([0]);
  });

  it('still exits 0 when the shutdown outlives the timeout', async () => {
    const { source, exits } = setup(() => new Promise(() => undefined), 10);
    source.emit('SIGTERM');
    await Bun.sleep(30);
    expect(exits).toEqual([0]);
  });

  it('exits 1 when the shutdown fails', async () => {
    const boom = new Error('boom');
    const { source, exits, errors } = setup(() => Promise.reject(boom));
    source.emit('SIGINT');
    await Bun.sleep(5);
    expect(exits).toEqual([1]);
    expect(errors).toEqual([boom]);
  });
});
