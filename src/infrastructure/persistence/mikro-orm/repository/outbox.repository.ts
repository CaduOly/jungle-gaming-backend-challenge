import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxMessage } from '../../../../business/messaging/entity/outbox-message';
import type { IOutboxRepository } from '../../../../business/messaging/port/outbox.repository.port';
import { FaultInjector } from '../../../fault-injection/fault-injector';
import {
  OUTBOX_COLUMNS,
  outboxMessageFromRow,
  type OutboxMessageRow,
  outboxMessageToInsertParams,
} from '../mapper/outbox-message.mapper';

interface RunResult {
  readonly affectedRows: number;
}

const INSERT_COLUMNS =
  'event_id, aggregate_type, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at';
const INSERT_PLACEHOLDERS = '(?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)';

const byOccurrence = (a: OutboxMessage, b: OutboxMessage): number =>
  a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** `now` always comes from the caller (IClock), never from the database clock. */
export class OutboxRepository implements IOutboxRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly faults: FaultInjector = FaultInjector.none(),
  ) {}

  async add(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    this.faults.trip('fail_outbox_insert');
    await this.em.execute(
      `INSERT INTO outbox_messages (${INSERT_COLUMNS}) VALUES ${messages.map(() => INSERT_PLACEHOLDERS).join(', ')}`,
      messages.flatMap(outboxMessageToInsertParams),
      'run',
    );
  }

  async claimBatch(limit: number, leaseMs: number, now: Date): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<OutboxMessageRow[]>(
      `UPDATE outbox_messages
          SET locked_until = ?, lease_token = gen_random_uuid()
        WHERE event_id IN (
                SELECT event_id
                  FROM outbox_messages
                 WHERE published_at IS NULL
                   AND next_attempt_at <= ?
                   AND (locked_until IS NULL OR locked_until <= ?)
                 ORDER BY occurred_at, event_id
                 LIMIT ?
                   FOR UPDATE SKIP LOCKED)
      RETURNING ${OUTBOX_COLUMNS}`,
      [new Date(now.getTime() + leaseMs), now, now, limit],
    );
    return rows.map(outboxMessageFromRow).sort(byOccurrence);
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.em.execute(
      `UPDATE outbox_messages
          SET published_at = ?, locked_until = NULL, lease_token = NULL
        WHERE event_id = ? AND published_at IS NULL`,
      [message.publishedAt ?? null, message.id],
      'run',
    );
  }

  async scheduleRetry(message: OutboxMessage): Promise<boolean> {
    if (message.leaseToken === undefined) return false;
    const result = await this.em.execute<RunResult>(
      `UPDATE outbox_messages
          SET attempts = ?, next_attempt_at = ?, locked_until = NULL, lease_token = NULL
        WHERE event_id = ? AND published_at IS NULL AND lease_token = ?`,
      [message.attempts, message.nextAttemptAt, message.id, message.leaseToken],
      'run',
    );
    return result.affectedRows === 1;
  }

  async findById(id: string): Promise<OutboxMessage | undefined> {
    const rows = await this.em.execute<OutboxMessageRow[]>(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox_messages WHERE event_id = ?`,
      [id],
    );
    return rows[0] && outboxMessageFromRow(rows[0]);
  }
}
