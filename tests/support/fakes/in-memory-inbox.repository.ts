import { InboxMessage, type InboxMessageState } from '../../../src/business/messaging/entity/inbox-message';
import type { IInboxRepository, InboxInsertResult } from '../../../src/business/messaging/port/inbox.repository.port';
import type { UndoLog } from './undo-log';

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

  /** View presa a uma unit of work: um rollback restaura toda linha que ela tocou. */
  withUndo(undo: UndoLog): IInboxRepository {
    const journal = (message: InboxMessage): void => {
      const key = keyOf(message.consumerName, message.messageId);
      const before = this.rows.get(key);
      undo.record(() => {
        if (before === undefined) this.rows.delete(key);
        else this.rows.set(key, before);
      });
    };
    return {
      insertIfAbsent: async (message) => {
        journal(message);
        return this.insertIfAbsent(message);
      },
      markProcessed: async (message) => {
        journal(message);
        return this.markProcessed(message);
      },
    };
  }

  size(): number {
    return this.rows.size;
  }
}
