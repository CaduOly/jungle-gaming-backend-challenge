import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { IUnitOfWork, UnitOfWorkOptions } from '../../../src/business/shared/port/unit-of-work.port';
import type { TxRepositories } from '../../../src/business/wagering/port/tx-repositories.port';
import { TransientInfrastructureError } from '../../../src/infrastructure/error/transient-infrastructure-error';
import { CLOCK, ID_GENERATOR, WAGERING_PERSISTENCE } from '../../../src/infrastructure/framework/nest/shared/di/tokens';
import type { WageringPersistence } from '../../../src/infrastructure/framework/nest/shared/di/wagering-persistence';
import { createHttpApp } from '../../../src/infrastructure/framework/nest/shared/http-app';
import { UuidV7IdGenerator } from '../../../src/infrastructure/id/uuid-v7-id-generator';
import { createFakeWageringApp, type FakeWageringApp } from '../../support/fakes/fake-wagering-app';
import { InMemoryWagerTransactionRepository } from '../../support/fakes/in-memory-wager-transaction-repository';
import { InMemoryWalletRepository } from '../../support/fakes/in-memory-wallet-repository';

/** A unit of work that can be switched to fail as a database outage would. */
export class SwitchableUnitOfWork implements IUnitOfWork<TxRepositories> {
  down = false;

  constructor(private readonly inner: IUnitOfWork<TxRepositories>) {}

  run<T>(work: (tx: TxRepositories) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
    if (this.down) {
      return Promise.reject(new TransientInfrastructureError('connection refused', '08006', { cause: undefined }));
    }
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

/** The real HTTP wiring (guards, pipes, filter, Swagger) over the in-memory fakes, listening on a free port. */
export const startInMemoryHttpApp = async (env: Record<string, string> = {}): Promise<InMemoryHttpApp> => {
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
    env: { HTTP_RETRY_AFTER_SECONDS: '3', ...env },
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return { app, fake, uow, baseUrl: `http://127.0.0.1:${address.port}`, close: () => app.close() };
};
