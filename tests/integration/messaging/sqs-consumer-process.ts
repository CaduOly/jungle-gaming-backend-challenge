import { readSqsConfig } from '../../../src/infrastructure/config/sqs-config';
import { readSqsConsumerConfig } from '../../../src/infrastructure/config/sqs-consumer-config';
import { FaultInjector } from '../../../src/infrastructure/fault-injection/fault-injector';
import { FaultInjectingMessageHandler } from '../../../src/infrastructure/messaging/sqs/fault-injecting-message-handler';
import { type IMessageHandler, MessageOutcome } from '../../../src/infrastructure/messaging/sqs/message-handler.port';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs/sqs-client';
import { SqsConsumerLoop } from '../../../src/infrastructure/messaging/sqs/sqs-consumer-loop';
import { installGracefulShutdown } from '../../../src/infrastructure/process/graceful-shutdown';

/**
 * Um consumer avulso para os testes de SIGTERM e de crash. Ele reporta no stdout, uma linha JSON por evento:
 * `started` quando uma mensagem chega no handler (antes do slow_handler segurar ela) e `handled` quando o
 * handler está para retornar o ack.
 */
const env = process.env;
const sqs = readSqsConfig(env);
const config = readSqsConsumerConfig(env);
const faults = FaultInjector.fromEnv(env);
const client = createSqsClient(sqs);
const report = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

const acking: IMessageHandler = {
  handle: async (message) => {
    report({ event: 'handled', sqsMessageId: message.sqsMessageId, body: message.body, receiveCount: message.receiveCount });
    return MessageOutcome.ack();
  },
};
const slow = new FaultInjectingMessageHandler(acking, faults);
const handler: IMessageHandler = {
  handle: (message, signal) => {
    report({ event: 'started', sqsMessageId: message.sqsMessageId, body: message.body });
    return slow.handle(message, signal);
  },
};

const consumer = new SqsConsumerLoop({
  client,
  queue: sqs.commandsQueue,
  deadLetterQueue: sqs.commandsDeadLetterQueue,
  handler,
  config,
  readiness: async () => undefined,
  faults,
  onError: (error, operation) => report({ event: 'error', operation, message: String(error) }),
});

installGracefulShutdown(
  async () => {
    const result = await consumer.stop();
    report({ event: 'stopped', ...result });
    client.destroy();
  },
  { timeoutMs: config.shutdownTimeoutMs + 1_000 },
);

consumer.start();
report({ event: 'ready' });
