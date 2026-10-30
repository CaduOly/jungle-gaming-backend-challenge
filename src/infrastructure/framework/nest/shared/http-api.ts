import type { IReadinessCheck } from '../../../health/readiness-check.port';
import type { Observability } from '../../../observability/observability';
import { WAGERING_PERSISTENCE } from './di/tokens';
import type { WageringPersistence } from './di/wagering-persistence';
import { createHttpApp } from './http-app';
import { readHttpConfig } from './http-config';

export interface HttpApiOptions {
  readonly persistence: WageringPersistence;
  readonly readinessChecks: readonly IReadinessCheck[];
  readonly readinessDetails: () => Record<string, unknown>;
  readonly instanceId: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Logger e registry da réplica, então o /metrics também mostra o que os workers desse processo contaram. */
  readonly observability: Observability;
}

export interface RunningHttpApi {
  readonly port: number;
  /** Para de aceitar conexão e resolve quando as requests em andamento forem respondidas. */
  close(): Promise<void>;
}

/** A API de uma réplica, ouvindo na PORT. Os sinais são do entry point do processo, então os hooks do Nest ficam desligados. */
export const startHttpApi = async (options: HttpApiOptions): Promise<RunningHttpApi> => {
  const app = await createHttpApp({
    persistence: { provide: WAGERING_PERSISTENCE, useValue: options.persistence },
    readinessChecks: options.readinessChecks,
    readinessDetails: options.readinessDetails,
    instanceId: options.instanceId,
    env: options.env,
    shutdownHooks: false,
    observability: options.observability,
  });
  await app.listen(readHttpConfig(options.env).port, '0.0.0.0');
  const address = app.getHttpServer().address() as { port: number };
  return { port: address.port, close: () => app.close() };
};
