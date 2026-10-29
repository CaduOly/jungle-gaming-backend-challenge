import {
  reconcileWallet,
  type WalletReconciliation,
} from '../../../src/business/wallet/domain-service/wallet-reconciliation';
import type { Wallet } from '../../../src/business/wallet/entity/wallet';
import type { ILedgerReader } from '../../../src/business/wallet/port/ledger-reader.port';

/**
 * Reconciles a wallet against an in-memory ledger. Lets specs of other bounded contexts check the wallet
 * invariant without importing wallet/domain-service directly.
 */
export const reconcileInMemoryWallet = async (
  wallet: Wallet,
  ledger: Pick<ILedgerReader, 'listAll'>,
): Promise<WalletReconciliation> => reconcileWallet(wallet, await ledger.listAll(wallet.id));
