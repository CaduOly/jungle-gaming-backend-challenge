import { Money } from '../../../src/business/shared/value-object/money';
import { WalletConsistencyError } from '../assert-wallet-consistency';
import type { FakeDatabase } from './fake-unit-of-work';

/**
 * In-memory twin of the SQL `assertWalletConsistency`, written independently of `reconcileWallet`:
 * balance == Σcredit − Σdebit, before[n] == after[n−1] by seq, strictly increasing versions ending at
 * wallet.version, and version 1 when there is no entry.
 */
export const findFakeWalletInconsistencies = async (db: FakeDatabase, walletId: string): Promise<string[]> => {
  const wallet = db.wallets.read(walletId);
  if (wallet === null) return [`wallet ${walletId} not found`];
  const entries = [...(await db.ledger.listAll(walletId))].sort((a, b) => ((a.seq ?? 0n) < (b.seq ?? 0n) ? -1 : 1));
  const violations: string[] = [];
  let credits = Money.zero(wallet.currency);
  let debits = Money.zero(wallet.currency);
  entries.forEach((entry, index) => {
    if (entry.isCredit()) credits = credits.add(entry.amount);
    else debits = debits.add(entry.amount);
    const expectedAfter = entry.isCredit()
      ? entry.balanceBefore.add(entry.amount)
      : entry.balanceBefore.isGreaterThanOrEqual(entry.amount)
        ? entry.balanceBefore.subtract(entry.amount)
        : null;
    if (expectedAfter === null || !expectedAfter.equals(entry.balanceAfter)) {
      violations.push(`seq ${entry.seq} arithmetic broken`);
    }
    const previous = entries[index - 1];
    if (previous === undefined) {
      if (!entry.balanceBefore.isZero()) violations.push(`seq ${entry.seq} first balance_before is not 0`);
      return;
    }
    if (!entry.balanceBefore.equals(previous.balanceAfter)) violations.push(`seq ${entry.seq} does not chain`);
    if (entry.walletVersion <= previous.walletVersion) violations.push(`seq ${entry.seq} version does not grow`);
  });
  const last = entries.at(-1);
  if (last === undefined && wallet.version !== 1) violations.push(`version ${wallet.version} with no entries`);
  if (last !== undefined && last.walletVersion !== wallet.version) violations.push('last version differs');
  if (last !== undefined && !last.balanceAfter.equals(wallet.balance)) violations.push('last balance differs');
  if (!credits.isGreaterThanOrEqual(debits) || !credits.subtract(debits).equals(wallet.balance)) {
    violations.push(`balance ${wallet.balance} differs from ledger sum (credits ${credits}, debits ${debits})`);
  }
  return violations;
};

export const assertFakeWalletConsistency = async (db: FakeDatabase, walletId: string): Promise<void> => {
  const violations = await findFakeWalletInconsistencies(db, walletId);
  if (violations.length > 0) throw new WalletConsistencyError(walletId, violations);
};

export const assertEveryFakeWalletConsistent = async (db: FakeDatabase): Promise<void> => {
  for (const wallet of db.wallets.all()) await assertFakeWalletConsistency(db, wallet.id);
};
