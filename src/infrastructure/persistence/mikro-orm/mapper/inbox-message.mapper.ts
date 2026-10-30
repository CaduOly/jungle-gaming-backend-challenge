import { InboxMessage } from '../../../../business/messaging/entity/inbox-message';
import { toDate, toOptionalDate } from './sql-values';

export interface InboxMessageRow {
  readonly consumer_name: string;
  readonly message_id: string;
  readonly payload_hash: string;
  readonly received_at: unknown;
  readonly processed_at: unknown;
}

export const inboxMessageFromRow = (row: InboxMessageRow): InboxMessage => {
  const processedAt = toOptionalDate(row.processed_at);
  return InboxMessage.rehydrate({
    consumerName: row.consumer_name,
    messageId: row.message_id,
    payloadHash: row.payload_hash,
    receivedAt: toDate(row.received_at),
    ...(processedAt ? { processedAt } : {}),
  });
};

export const inboxMessageToParams = (message: InboxMessage): unknown[] => [
  message.consumerName,
  message.messageId,
  message.payloadHash,
  message.receivedAt,
  message.processedAt ?? null,
];
