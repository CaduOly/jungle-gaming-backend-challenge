import { InboxMessage, type InboxMessageState } from '../../../src/business/messaging/entity/inbox-message';
import type { IInboxRepository, InboxInsertResult } from '../../../src/business/messaging/port/inbox.repository.port';

const keyOf = (consumerName: string, messageId: string): string => JSON.stringify([consumerName, messageId]);

export class InMemoryInboxRepository implements IInboxRepository {
  private readonly rows = new Map<string, InboxMessageState>();

  async insertIfAbsent(message: InboxMessage): Promise<InboxInsertResult> {
    const key = keyOf(message.consumerName, message.messageId);
    const existing = this.rows.get(key);
    if (existing) return { inserted: false, existing: InboxMessage.rehydrate(existing) };
    this.rows.set(key, message.toState());
    return { inserted: true };
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    const key = keyOf(message.consumerName, message.messageId);
    const stored = this.rows.get(key);
    if (!stored) throw new Error(`Inbox message ${key} does not exist`);
    if (stored.processedAt) return;
    this.rows.set(key, { ...stored, processedAt: message.processedAt });
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const stored = this.rows.get(keyOf(consumerName, messageId));
    return stored && InboxMessage.rehydrate(stored);
  }

  size(): number {
    return this.rows.size;
  }
}
