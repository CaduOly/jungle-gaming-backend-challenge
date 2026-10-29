import { describe, expect, it } from 'bun:test';
import { OutboxMessage } from '../../business/messaging/entity/outbox-message';
import { FakeMessagePublisher } from '../../../tests/support/fakes/fake-message-publisher';
import { aFakeEvent } from '../../../tests/support/fakes/fake-integration-event';
import { FaultInjector } from '../fault-injection/fault-injector';
import { FaultInjectingMessagePublisher } from './fault-injecting-message-publisher';

describe('FaultInjectingMessagePublisher', () => {
  it('crashes after the inner publish succeeded', async () => {
    const inner = new FakeMessagePublisher();
    const crashes: string[] = [];
    const message = OutboxMessage.fromEvent(aFakeEvent());
    const publisher = new FaultInjectingMessagePublisher(
      inner,
      FaultInjector.of('crash_after_publish_before_mark'),
      () => crashes.push(`crash with ${inner.publishedIds().join(',')}`),
    );

    await publisher.publish(message);

    expect(crashes).toEqual([`crash with ${message.id}`]);
  });

  it('does not crash when the publish failed', async () => {
    const inner = new FakeMessagePublisher();
    inner.failNext();
    const crashes: number[] = [];
    const publisher = new FaultInjectingMessagePublisher(
      inner,
      FaultInjector.of('crash_after_publish_before_mark'),
      () => crashes.push(1),
    );

    await expect(publisher.publish(OutboxMessage.fromEvent(aFakeEvent()))).rejects.toThrow();
    expect(crashes).toEqual([]);
  });

  it('is a plain pass-through when the fault is inactive', async () => {
    const inner = new FakeMessagePublisher();
    const crashes: number[] = [];
    const message = OutboxMessage.fromEvent(aFakeEvent());

    await new FaultInjectingMessagePublisher(inner, FaultInjector.none(), () => crashes.push(1)).publish(message);

    expect(inner.publishedIds()).toEqual([message.id]);
    expect(crashes).toEqual([]);
  });
});
