import type { IReadinessCheck } from '../../../health/readiness-check.port';
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
}

export interface RunningHttpApi {
  readonly port: number;
  /** Stops accepting connections and resolves once the requests in flight are answered. */
  close(): Promise<void>;
}

/** The API of one replica, listening on PORT. The process entry point owns the signals, so Nest's hooks stay off. */
export const startHttpApi = async (options: HttpApiOptions): Promise<RunningHttpApi> => {
  const app = await createHttpApp({
    persistence: { provide: WAGERING_PERSISTENCE, useValue: options.persistence },
    readinessChecks: options.readinessChecks,
    readinessDetails: options.readinessDetails,
    instanceId: options.instanceId,
    env: options.env,
    shutdownHooks: false,
  });
  await app.listen(readHttpConfig(options.env).port, '0.0.0.0');
  const address = app.getHttpServer().address() as { port: number };
  return { port: address.port, close: () => app.close() };
};
