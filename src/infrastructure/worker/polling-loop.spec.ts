import { describe, expect, it } from 'bun:test';
import { PollingLoop } from './polling-loop';

const until = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(1);
  }
};

describe('PollingLoop', () => {
  it('waits the delay chosen from each output and the error delay after a failure', async () => {
    const outputs = [0, 5_000];
    let rounds = 0;
    const errors: unknown[] = [];
    const loop = new PollingLoop<number>({
      round: async () => {
        rounds += 1;
        if (rounds === 2) throw new Error('boom');
        return outputs[rounds === 1 ? 0 : 1] ?? 0;
      },
      nextDelayMs: (delay) => delay,
      errorDelayMs: 1,
      onError: (error) => errors.push(error),
    });

    loop.start();
    await until(() => rounds === 3);
    await Bun.sleep(30);
    await loop.stop();

    expect(rounds).toBe(3);
    expect(errors).toHaveLength(1);
  });

  it('reports isStopping as soon as stop is called', async () => {
    let release: () => void = () => undefined;
    const loop = new PollingLoop<void>({
      round: () => new Promise<void>((resolve) => (release = resolve)),
      nextDelayMs: () => 0,
      errorDelayMs: 0,
    });
    loop.start();
    await Bun.sleep(5);
    const stopping = loop.stop();
    expect(loop.isStopping).toBe(true);
    expect(loop.isRunning).toBe(false);
    release();
    await stopping;
  });
});
