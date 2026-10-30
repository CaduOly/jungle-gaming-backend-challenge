import { describeWageringRepositoriesContract } from '../../support/contracts/wagering-repositories.contract';
import { createRealWageringApp, createWageringDatabase } from './wagering-orm';

describeWageringRepositoriesContract('PostgreSQL', async () => {
  const db = await createWageringDatabase();
  return {
    uow: createRealWageringApp(db.orm).uow,
    assertConsistent: (walletIds) => db.assertConsistent(walletIds),
    teardown: () => db.close(),
  };
});
