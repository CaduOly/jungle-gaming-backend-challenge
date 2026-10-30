import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxMessage } from '../../../../business/messaging/entity/inbox-message';
import type { IInboxRepository, InboxInsertResult } from '../../../../business/messaging/port/inbox.repository.port';
import { inboxMessageFromRow, type InboxMessageRow, inboxMessageToParams } from '../mapper/inbox-message.mapper';

interface RunResult {
  readonly affectedRows: number;
}

export class InboxRepository implements IInboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(message: InboxMessage): Promise<InboxInsertResult> {
    const result = await this.em.execute<RunResult>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING`,
      inboxMessageToParams(message),
      'run',
    );
    if (result.affectedRows === 1) return { inserted: true };

    const existing = await this.find(message.consumerName, message.messageId);
    if (!existing) throw new Error(`Inbox message ${message.consumerName}/${message.messageId} vanished after a conflict`);
    return { inserted: false, existing };
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    const result = await this.em.execute<RunResult>(
      `UPDATE inbox_messages SET processed_at = ?
        WHERE consumer_name = ? AND message_id = ? AND processed_at IS NULL`,
      [message.processedAt ?? null, message.consumerName, message.messageId],
      'run',
    );
    if (result.affectedRows === 0 && !(await this.find(message.consumerName, message.messageId))) {
      throw new Error(`Inbox message ${message.consumerName}/${message.messageId} does not exist`);
    }
  }

  private async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const rows = await this.em.execute<InboxMessageRow[]>(
      `SELECT consumer_name, message_id, payload_hash, received_at, processed_at
         FROM inbox_messages WHERE consumer_name = ? AND message_id = ?`,
      [consumerName, messageId],
    );
    return rows[0] && inboxMessageFromRow(rows[0]);
  }
}
