import {
  reconcileWallet,
  type WalletReconciliation,
} from '../../../src/business/wallet/domain-service/wallet-reconciliation';
import type { Wallet } from '../../../src/business/wallet/entity/wallet';
import type { ILedgerReader } from '../../../src/business/wallet/port/ledger-reader.port';

/**
 * Reconcilia uma wallet contra um ledger em memória. Deixa specs de outros bounded contexts checarem o invariante
 * da wallet sem importar wallet/domain-service direto.
 */
export const reconcileInMemoryWallet = async (
  wallet: Wallet,
  ledger: Pick<ILedgerReader, 'listAll'>,
): Promise<WalletReconciliation> => reconcileWallet(wallet, await ledger.listAll(wallet.id));
