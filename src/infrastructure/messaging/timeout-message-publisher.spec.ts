import { describe, expect, it } from 'bun:test';
import { OutboxMessage } from '../../business/messaging/entity/outbox-message';
import { aFakeEvent } from '../../../tests/support/fakes/fake-integration-event';
import { FakeMessagePublisher } from '../../../tests/support/fakes/fake-message-publisher';
import { PublishTimeoutError, TimeoutMessagePublisher } from './timeout-message-publisher';

describe('TimeoutMessagePublisher', () => {
  it('fails a publish that outlives the timeout', async () => {
    const hanging = { publish: () => new Promise<void>(() => undefined) };
    const publisher = new TimeoutMessagePublisher(hanging, 20);
    await expect(publisher.publish(OutboxMessage.fromEvent(aFakeEvent()))).rejects.toBeInstanceOf(PublishTimeoutError);
  });

  it('passes a fast publish and its failure through', async () => {
    const inner = new FakeMessagePublisher();
    const publisher = new TimeoutMessagePublisher(inner, 1_000);
    const message = OutboxMessage.fromEvent(aFakeEvent());
    await publisher.publish(message);
    expect(inner.publishedIds()).toEqual([message.id]);
    inner.failNext();
    await expect(publisher.publish(message)).rejects.toThrow('Fake publish failure');
  });
});
