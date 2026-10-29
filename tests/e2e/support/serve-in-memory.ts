import { readIntegerEnv } from '../../../src/infrastructure/config/integer-env';
import { WAGERING_PERSISTENCE } from '../../../src/infrastructure/framework/nest/shared/di/tokens';
import { createHttpApp } from '../../../src/infrastructure/framework/nest/shared/http-app';
import { createFakeWageringApp } from '../../support/fakes/fake-wagering-app';
import { InMemoryWagerTransactionRepository } from '../../support/fakes/in-memory-wager-transaction-repository';
import { InMemoryWalletRepository } from '../../support/fakes/in-memory-wallet-repository';
import { SystemClock } from '../../../src/infrastructure/clock/system-clock';
import { CLOCK } from '../../../src/infrastructure/framework/nest/shared/di/tokens';

/** Local API over the in-memory fakes (no PostgreSQL yet): `bun run start:in-memory`, then open /docs. */
const fake = createFakeWageringApp();
const app = await createHttpApp({
  persistence: {
    provide: WAGERING_PERSISTENCE,
    useValue: {
      unitOfWork: fake.uow,
      wallets: new InMemoryWalletRepository(fake.db.wallets),
      ledger: fake.db.ledger,
      transactions: new InMemoryWagerTransactionRepository(fake.db.wagers),
    },
  },
  overrides: [{ provide: CLOCK, useClass: SystemClock }],
});
await app.listen(readIntegerEnv(process.env, 'PORT', 3000));
