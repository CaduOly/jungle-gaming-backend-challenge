import 'reflect-metadata';
import { readSqsConsumerConfig } from './infrastructure/config/sqs-consumer-config';
import { installGracefulShutdown } from './infrastructure/process/graceful-shutdown';
import { startApplication } from './infrastructure/runtime/application';

/**
 * Uma imagem, qualquer combinação de roles: APP_ROLES=api,consumer,outbox,pending-worker (todas por default).
 * SIGTERM/SIGINT param todas as roles dentro de SHUTDOWN_TIMEOUT_MS, e o `bun run migrate` tem que rodar antes da
 * primeira réplica subir.
 */
if (import.meta.main) {
  const application = await startApplication(process.env);
  installGracefulShutdown(() => application.stop(), {
    timeoutMs: readSqsConsumerConfig(process.env).shutdownTimeoutMs + 2_000,
    onError: (error) => console.error(error),
  });
}
