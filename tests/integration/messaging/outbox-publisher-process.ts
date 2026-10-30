import { MikroORM } from '@mikro-orm/postgresql';
import { readDatabaseUrl } from '../../../src/infrastructure/config/database-url';
import { readOutboxPublisherConfig } from '../../../src/infrastructure/config/outbox-publisher-config';
import { readSqsConfig } from '../../../src/infrastructure/config/sqs-config';
import { SystemClock } from '../../../src/infrastructure/clock/system-clock';
import { FaultInjector } from '../../../src/infrastructure/fault-injection/fault-injector';
import { createOutboxPublisherWorker } from '../../../src/infrastructure/messaging/outbox/outbox-publisher-worker.factory';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs/sqs-client';
import { SqsMessagePublisher } from '../../../src/infrastructure/messaging/sqs/sqs-message-publisher';
import { createMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm/mikro-orm.config';

/** Um publisher de outbox avulso, que o teste de crash sobe para o FAULT_INJECTION dar SIGKILL de verdade. */
const env = process.env;
const sqs = readSqsConfig(env);
const client = createSqsClient(sqs);
const orm = await MikroORM.init(createMikroOrmConfig(readDatabaseUrl(env)));
const worker = createOutboxPublisherWorker({
  em: orm.em,
  publisher: new SqsMessagePublisher(client, sqs.eventsQueue),
  clock: new SystemClock(),
  config: readOutboxPublisherConfig(env),
  faults: FaultInjector.fromEnv(env),
  onRound: (round) => console.log(JSON.stringify({ round })),
  onError: (error) => console.error(error),
});

process.once('SIGTERM', () => {
  void worker
    .stop()
    .then(() => orm.close(true))
    .then(() => {
      client.destroy();
      process.exit(0);
    });
});

worker.start();
