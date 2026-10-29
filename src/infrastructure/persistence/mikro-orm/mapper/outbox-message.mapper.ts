import { OutboxMessage } from '../../../../business/messaging/entity/outbox-message';
import type { IntegrationEventEnvelope } from '../../../../business/messaging/event/integration-event';
import { toDate, toJsonObject, toOptionalDate, toOptionalString } from './sql-values';

export interface OutboxMessageRow {
  readonly event_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly occurred_at: unknown;
  readonly attempts: number;
  readonly next_attempt_at: unknown;
  readonly locked_until: unknown;
  readonly lease_token: unknown;
  readonly published_at: unknown;
}

export const OUTBOX_COLUMNS =
  'event_id, aggregate_type, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, ' +
  'locked_until, lease_token, published_at';

export const outboxMessageFromRow = (row: OutboxMessageRow): OutboxMessage => {
  const lockedUntil = toOptionalDate(row.locked_until);
  const leaseToken = toOptionalString(row.lease_token);
  const publishedAt = toOptionalDate(row.published_at);
  return OutboxMessage.rehydrate({
    id: row.event_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: toJsonObject<IntegrationEventEnvelope>(row.payload),
    occurredAt: toDate(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: toDate(row.next_attempt_at),
    ...(lockedUntil ? { lockedUntil } : {}),
    ...(leaseToken ? { leaseToken } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  });
};

/** Insert parameters. A new row never carries a lease: claims are the only way to get one. */
export const outboxMessageToInsertParams = (message: OutboxMessage): unknown[] => [
  message.id,
  message.aggregateType,
  message.aggregateId,
  message.eventType,
  JSON.stringify(message.payload),
  message.occurredAt,
  message.attempts,
  message.nextAttemptAt,
  message.publishedAt ?? null,
];
