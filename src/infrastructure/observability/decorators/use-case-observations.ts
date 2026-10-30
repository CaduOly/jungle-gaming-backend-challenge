import type {
  ProcessWagerTransactionInput,
  ProcessWagerTransactionOutput,
} from '../../../business/wagering/use-case/process-wager-transaction/process-wager-transaction.dto';
import type { GetWagerTransactionInput, WagerTransactionView } from '../../../business/wagering/use-case/get-wager-transaction/get-wager-transaction';
import type { CreateWalletInput } from '../../../business/wallet/use-case/create-wallet/create-wallet';
import type { GetLedgerInput, GetLedgerOutput } from '../../../business/wallet/use-case/get-ledger/get-ledger';
import type { GetWalletInput } from '../../../business/wallet/use-case/get-wallet/get-wallet';
import type {
  ReconcileWalletInput,
  ReconcileWalletOutput,
} from '../../../business/wallet/use-case/reconcile-wallet/reconcile-wallet';
import type { WalletView } from '../../../business/wallet/use-case/wallet-view';
import type { UseCaseObservation } from './observe-use-case';

/**
 * No SQS a mensagem é ao mesmo tempo a correlation (a não ser que o comando traga a dele) e a causa, do jeito que o
 * use case grava nos eventos. Alimenta wager_transactions_total (só decisões) ou idempotent_duplicates_total
 * (replays). O summary guarda a decisão (status, failureCode) e deixa o saldo de fora.
 */
export const processWagerTransactionObservation: UseCaseObservation<
  ProcessWagerTransactionInput,
  ProcessWagerTransactionOutput
> = {
  operation: 'process_wager_transaction',
  contextOf: (input) => {
    const messageId = input.source.channel === 'SQS' ? input.source.messageId : undefined;
    return {
      correlationId: input.correlationId ?? messageId,
      causationId: messageId,
      messageId,
      providerId: input.actor.providerId,
      walletId: input.payload.walletId,
    };
  },
  summaryOf: (output) => ({
    transactionId: output.transactionId,
    kind: output.kind,
    status: output.status,
    failureCode: output.failureCode,
    idempotentReplay: output.idempotentReplay,
    channel: output.channel,
  }),
  outcomeOf: (output) => (output.idempotentReplay ? 'replay' : output.status.toLowerCase()),
  record: (output, metrics) => {
    if (output.idempotentReplay) metrics.idempotentDuplicates.inc({ channel: output.channel.toLowerCase() });
    else metrics.wagerTransactions.inc({ status: output.status, kind: output.kind });
  },
};

export const createWalletObservation: UseCaseObservation<CreateWalletInput, WalletView> = {
  operation: 'create_wallet',
  contextOf: (input) => ({ correlationId: input.correlationId }),
  summaryOf: (output) => ({ walletId: output.id }),
};

export const getWalletObservation: UseCaseObservation<GetWalletInput, WalletView> = {
  operation: 'get_wallet',
  contextOf: (input) => ({ walletId: input.walletId }),
};

export const getLedgerObservation: UseCaseObservation<GetLedgerInput, GetLedgerOutput> = {
  operation: 'get_ledger',
  contextOf: (input) => ({ walletId: input.walletId }),
  summaryOf: (output) => ({ entries: output.entries.length }),
};

export const getWagerTransactionObservation: UseCaseObservation<GetWagerTransactionInput, WagerTransactionView> = {
  operation: 'get_wager_transaction',
  contextOf: (input) => ('transactionId' in input ? { transactionId: input.transactionId } : { providerId: input.providerId }),
  summaryOf: (output) => ({ transactionId: output.transactionId, walletId: output.walletId, status: output.status }),
};

/** Divergência é contada e logada, nunca corrigida, e os valores ficam fora da linha. */
export const reconcileWalletObservation: UseCaseObservation<ReconcileWalletInput, ReconcileWalletOutput> = {
  operation: 'reconcile_wallet',
  contextOf: (input) => ({ walletId: input.walletId }),
  summaryOf: (output) => ({
    consistent: output.consistent,
    checkedEntries: output.checkedEntries,
    divergences: output.divergences.length,
  }),
  outcomeOf: (output) => (output.consistent ? 'consistent' : 'divergent'),
  record: (output, metrics) => {
    if (!output.consistent) metrics.reconciliationDivergences.inc();
  },
};
