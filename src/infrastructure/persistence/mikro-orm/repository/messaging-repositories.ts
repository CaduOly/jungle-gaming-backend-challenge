import type { EntityManager } from '@mikro-orm/postgresql';
import type { IInboxRepository } from '../../../../business/messaging/port/inbox.repository.port';
import type { IOutboxRepository } from '../../../../business/messaging/port/outbox.repository.port';
import { FaultInjector } from '../../../fault-injection/fault-injector';
import { InboxRepository } from './inbox.repository';
import { OutboxRepository } from './outbox.repository';

export interface MessagingRepositories {
  readonly inbox: IInboxRepository;
  readonly outbox: IOutboxRepository;
}

/** Building block for the UoW factory: spread next to the wallet/wagering repositories. */
export const createMessagingRepositories = (
  em: EntityManager,
  faults: FaultInjector = FaultInjector.none(),
): MessagingRepositories => ({
  inbox: new InboxRepository(em),
  outbox: new OutboxRepository(em, faults),
});
