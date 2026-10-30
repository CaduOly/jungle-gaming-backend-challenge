import { MikroORM } from '@mikro-orm/postgresql';
import { readDatabaseConfig } from '../../../src/infrastructure/config/database-config';
import { readPendingReferenceWorkerConfig } from '../../../src/infrastructure/config/pending-reference-worker-config';
import { readSqsConfig } from '../../../src/infrastructure/config/sqs-config';
import { readSqsConsumerConfig } from '../../../src/infrastructure/config/sqs-consumer-config';
import { FaultInjector } from '../../../src/infrastructure/fault-injection/fault-injector';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs/sqs-client';
import { createMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm/mikro-orm.config';
import { createWagerCommandConsumer } from '../../../src/infrastructure/wagering/wager-command-consumer.factory';

/**
 * O consumer de comandos real num processo próprio, para o teste de crash. Ele reporta no stdout, uma linha JSON
 * por evento: `processed` quando o use case commitou uma decisão (antes do ack, onde o crash_after_commit_before_ack
 * mata o processo).
 */
const env = process.env;
const database = readDatabaseConfig(env);
const sqs = readSqsConfig(env);
const orm = await MikroORM.init(createMikroOrmConfig(database.url));
const client = createSqsClient(sqs);
const report = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

const consumer = createWagerCommandConsumer({
  em: orm.em,
  client,
  sqs,
  config: readSqsConsumerConfig(env),
  referenceBackoff: readPendingReferenceWorkerConfig(env, { lockTimeoutMs: database.lockTimeoutMs }).backoff,
  lockTimeoutMs: database.lockTimeoutMs,
  faults: FaultInjector.fromEnv(env),
  handler: {
    onProcessed: (output, message) =>
      report({ event: 'processed', sqsMessageId: message.sqsMessageId, ...output }),
  },
  onError: (error, operation) => report({ event: 'error', operation, message: String(error) }),
});

consumer.start();
report({ event: 'ready' });
