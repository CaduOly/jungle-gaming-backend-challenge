import { describeInboxRepositoryContract } from '../../../../tests/support/contracts/inbox-repository.contract';
import { describeOutboxRepositoryContract } from '../../../../tests/support/contracts/outbox-repository.contract';
import { InMemoryInboxRepository } from '../../../../tests/support/fakes/in-memory-inbox.repository';
import { InMemoryOutboxRepository } from '../../../../tests/support/fakes/in-memory-outbox.repository';

describeInboxRepositoryContract('in-memory fake', async () => ({ repository: new InMemoryInboxRepository() }));
describeOutboxRepositoryContract('in-memory fake', async () => ({ repository: new InMemoryOutboxRepository() }));
