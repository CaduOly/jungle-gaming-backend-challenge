import { describe, expect, it } from 'bun:test';
import { DisposeTimeoutError, ResourceScope, settleAllOrThrow } from '../../support/settle';

describe('ResourceScope', () => {
  it('disposes a resource that finishes being created after dispose() started', async () => {
    const scope = new ResourceScope();
    const pending = Promise.withResolvers<string>();
    const disposed: string[] = [];
    void scope.track(pending.promise, async (value) => {
      disposed.push(value);
    });

    const disposing = scope.dispose();
    pending.resolve('late-database');
    await disposing;

    expect(disposed).toEqual(['late-database']);
  });

  it('skips resources whose creation failed and still disposes the others', async () => {
    const scope = new ResourceScope();
    const disposed: string[] = [];
    const record = async (value: string) => {
      disposed.push(value);
    };
    const failure = settleAllOrThrow([
      scope.track(Promise.resolve('first'), record),
      scope.track(Promise.reject(new Error('boom')), record),
      scope.track(Promise.resolve('third'), record),
    ]);

    await expect(failure).rejects.toBeInstanceOf(AggregateError);
    await scope.dispose();
    expect(disposed.sort()).toEqual(['first', 'third']);
  });

  it('runs every disposer and then reports the failures', async () => {
    const scope = new ResourceScope();
    const disposed: string[] = [];
    await scope.track(Promise.resolve('a'), async () => {
      throw new Error('cannot drop');
    });
    await scope.track(Promise.resolve('b'), async (value) => {
      disposed.push(value);
    });

    await expect(scope.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(disposed).toEqual(['b']);
  });

  it('disposes one at a time, in reverse order of tracking', async () => {
    const scope = new ResourceScope();
    const events: string[] = [];
    for (const name of ['database', 'queues', 'consumer']) {
      await scope.track(Promise.resolve(name), async (value) => {
        events.push(`${value}:start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`${value}:end`);
      });
    }
    await scope.dispose();
    expect(events).toEqual([
      'consumer:start',
      'consumer:end',
      'queues:start',
      'queues:end',
      'database:start',
      'database:end',
    ]);
  });

  it('bounds each disposer with a timeout and still disposes the rest', async () => {
    const scope = new ResourceScope(20);
    const disposed: string[] = [];
    await scope.track(Promise.resolve('first'), async (value) => {
      disposed.push(value);
    });
    await scope.track(Promise.resolve('stuck'), () => new Promise(() => {}));
    const error = await scope.dispose().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBeInstanceOf(DisposeTimeoutError);
    expect(disposed).toEqual(['first']);
  });
});
