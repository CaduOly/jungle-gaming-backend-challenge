import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { IUnitOfWork, UnitOfWorkOptions } from '../../../src/business/shared/port/unit-of-work.port';
import type { TxRepositories } from '../../../src/business/wagering/port/tx-repositories.port';
import { TransientInfrastructureError } from '../../../src/infrastructure/error/transient-infrastructure-error';
import { CLOCK, ID_GENERATOR, WAGERING_PERSISTENCE } from '../../../src/infrastructure/framework/nest/shared/di/tokens';
import type { WageringPersistence } from '../../../src/infrastructure/framework/nest/shared/di/wagering-persistence';
import { createHttpApp } from '../../../src/infrastructure/framework/nest/shared/http-app';
import type { IReadinessCheck } from '../../../src/infrastructure/health/readiness-check.port';
import type { Observability } from '../../../src/infrastructure/observability/observability';
import { UuidV7IdGenerator } from '../../../src/infrastructure/id/uuid-v7-id-generator';
import { createFakeWageringApp, type FakeWageringApp } from '../../support/fakes/fake-wagering-app';
import { InMemoryWagerTransactionRepository } from '../../support/fakes/in-memory-wager-transaction-repository';
import { InMemoryWalletRepository } from '../../support/fakes/in-memory-wallet-repository';

export const databaseDown = (): TransientInfrastructureError =>
  new TransientInfrastructureError('connection refused', '08006', { cause: undefined });

/** Uma unit of work que dá para fazer falhar, como uma queda do banco (ou um bug) faria. */
export class SwitchableUnitOfWork implements IUnitOfWork<TxRepositories> {
  failure: unknown = undefined;
  /** Nunca termina, assim como uma query num banco pausado. */
  hanging = false;

  constructor(private readonly inner: IUnitOfWork<TxRepositories>) {}

  run<T>(work: (tx: TxRepositories) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
    if (this.hanging) return new Promise<T>(() => undefined);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return this.inner.run(work, options);
  }
}

export interface InMemoryHttpApp {
  readonly app: INestApplication;
  readonly fake: FakeWageringApp;
  readonly uow: SwitchableUnitOfWork;
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** O wiring HTTP real (guards, pipes, filter, Swagger) em cima dos fakes em memória, ouvindo numa porta livre. */
export interface InMemoryHttpAppOptions {
  readonly env?: Record<string, string>;
  /** Nenhuma por padrão: em cima dos fakes não tem dependência para checar, então a instância está sempre pronta. */
  readonly readinessChecks?: readonly IReadinessCheck[];
  /** O logger e as métricas para verificar; senão um logger silencioso e um registry novo. */
  readonly observability?: Observability;
  readonly instanceId?: string;
  readonly readinessDetails?: () => Record<string, unknown>;
}

export const startInMemoryHttpApp = async ({
  env = {},
  readinessChecks,
  observability,
  instanceId,
  readinessDetails,
}: InMemoryHttpAppOptions = {}): Promise<InMemoryHttpApp> => {
  const fake = createFakeWageringApp();
  const uow = new SwitchableUnitOfWork(fake.uow);
  const persistence: WageringPersistence = {
    unitOfWork: uow,
    wallets: new InMemoryWalletRepository(fake.db.wallets),
    ledger: fake.db.ledger,
    transactions: new InMemoryWagerTransactionRepository(fake.db.wagers),
  };
  const app = await createHttpApp({
    persistence: { provide: WAGERING_PERSISTENCE, useValue: persistence },
    overrides: [
      { provide: CLOCK, useValue: fake.clock },
      { provide: ID_GENERATOR, useClass: UuidV7IdGenerator },
    ],
    env: { HTTP_RETRY_AFTER_SECONDS: '3', HEALTH_READINESS_TIMEOUT_MS: '50', ...env },
    logger: false,
    ...(readinessChecks === undefined ? {} : { readinessChecks }),
    ...(observability === undefined ? {} : { observability }),
    ...(instanceId === undefined ? {} : { instanceId }),
    ...(readinessDetails === undefined ? {} : { readinessDetails }),
  });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return { app, fake, uow, baseUrl: `http://127.0.0.1:${address.port}`, close: () => app.close() };
};
