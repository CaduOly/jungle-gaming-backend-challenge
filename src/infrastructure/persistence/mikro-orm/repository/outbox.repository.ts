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

/** `now` sempre vem de quem chama (IClock), nunca do clock do banco. */
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

  /**
   * Head-of-line em dois passos, assim um aggregate quente com backlog longo custa uma consulta no índice, não um
   * scan:
   * 1. `aggregates` percorre os aggregates distintos com mensagem não publicada (um loose index scan em
   *    outbox_messages_unpublished_by_aggregate) e `heads` pega o menor seq de cada um;
   * 2. só depois as heads são filtradas por next_attempt_at e pelo lease, ordenadas por seq, limitadas e travadas
   *    (SKIP LOCKED). Head com lease ou ainda não vencida sai no filtro e o aggregate dela não entrega nada.
   */
  async claimBatch(limit: number, leaseMs: number, now: Date): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<OutboxMessageRow[]>(
      `WITH RECURSIVE aggregates AS (
         (SELECT aggregate_id FROM outbox_messages WHERE published_at IS NULL ORDER BY aggregate_id LIMIT 1)
         UNION ALL
         SELECT (SELECT n.aggregate_id
                   FROM outbox_messages n
                  WHERE n.published_at IS NULL AND n.aggregate_id > a.aggregate_id
                  ORDER BY n.aggregate_id
                  LIMIT 1)
           FROM aggregates a
          WHERE a.aggregate_id IS NOT NULL
       ),
       heads AS (
         SELECT h.event_id
           FROM aggregates a
           CROSS JOIN LATERAL (
                 SELECT p.event_id
                   FROM outbox_messages p
                  WHERE p.aggregate_id = a.aggregate_id AND p.published_at IS NULL
                  ORDER BY p.seq
                  LIMIT 1) h
          WHERE a.aggregate_id IS NOT NULL
       ),
       claimed AS (
         UPDATE outbox_messages
            SET locked_until = ?, lease_token = gen_random_uuid()
          WHERE event_id IN (
                  SELECT o.event_id
                    FROM outbox_messages o
                   WHERE o.event_id IN (SELECT event_id FROM heads)
                     AND o.published_at IS NULL
                     AND o.next_attempt_at <= ?
                     AND (o.locked_until IS NULL OR o.locked_until <= ?)
                   ORDER BY o.seq
                   LIMIT ?
                     FOR UPDATE SKIP LOCKED)
         RETURNING ${OUTBOX_COLUMNS}, seq)
       SELECT ${OUTBOX_COLUMNS} FROM claimed ORDER BY seq`,
      [new Date(now.getTime() + leaseMs), now, now, limit],
    );
    return rows.map(outboxMessageFromRow);
  }

  async markPublished(message: OutboxMessage): Promise<boolean> {
    const result = await this.em.execute<RunResult>(
      `UPDATE outbox_messages
          SET published_at = ?, locked_until = NULL, lease_token = NULL
        WHERE event_id = ? AND published_at IS NULL`,
      [message.publishedAt ?? null, message.id],
      'run',
    );
    return result.affectedRows === 1;
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
