import { assertFakeWalletConsistency } from '../../../../tests/support/assertions/assert-fake-wallet-consistency';
import { describeWageringRepositoriesContract } from '../../../../tests/support/contracts/wagering-repositories.contract';
import { FakeUnitOfWork } from '../../../../tests/support/fakes/fake-unit-of-work';

describeWageringRepositoriesContract('in-memory fake', async () => {
  const uow = new FakeUnitOfWork();
  return {
    uow,
    assertConsistent: async (walletIds) => {
      for (const walletId of walletIds) await assertFakeWalletConsistency(uow.db, walletId);
    },
  };
});
