import 'reflect-metadata';
import { readSqsConsumerConfig } from './infrastructure/config/sqs-consumer-config';
import { installGracefulShutdown } from './infrastructure/process/graceful-shutdown';
import { startApplication } from './infrastructure/runtime/application';

/**
 * One image, any mix of roles: APP_ROLES=api,consumer,outbox,pending-worker (all by default). SIGTERM/SIGINT stop
 * every role within SHUTDOWN_TIMEOUT_MS; run `bun run migrate` before the first replica starts.
 */
if (import.meta.main) {
  const application = await startApplication(process.env);
  installGracefulShutdown(() => application.stop(), {
    timeoutMs: readSqsConsumerConfig(process.env).shutdownTimeoutMs + 2_000,
    onError: (error) => console.error(error),
  });
}
