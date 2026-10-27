import type { InboxMessage } from '../entity/inbox-message';

export type InboxInsertResult =
  | { readonly inserted: true }
  | { readonly inserted: false; readonly existing: InboxMessage };

export interface IInboxRepository {
  /**
   * Inserts the message unless (consumerName, messageId) already exists. When it does, the stored
   * row is returned so the caller can tell a replay (processed, same hash) from a payload mismatch.
   */
  insertIfAbsent(message: InboxMessage): Promise<InboxInsertResult>;
  markProcessed(message: InboxMessage): Promise<void>;
}
