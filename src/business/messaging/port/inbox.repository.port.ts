import type { InboxMessage } from '../entity/inbox-message';

export type InboxInsertResult =
  | { readonly inserted: true }
  | { readonly inserted: false; readonly existing: InboxMessage };

export interface IInboxRepository {
  /**
   * Insere a mensagem se (consumerName, messageId) ainda não existir. Se já existir, devolve a linha
   * gravada para quem chamou distinguir um replay (processado, mesmo hash) de um payload divergente.
   */
  insertIfAbsent(message: InboxMessage): Promise<InboxInsertResult>;
  markProcessed(message: InboxMessage): Promise<void>;
}
