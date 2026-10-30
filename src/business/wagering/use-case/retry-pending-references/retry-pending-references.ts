import { OutboxMessage } from '../../../messaging/entity/outbox-message';
import { BusinessRuleError } from '../../../shared/error/business-rule-error';
import { DomainError } from '../../../shared/error/domain-error';
import { FailureCode } from '../../../shared/error/failure-code';
import type { ExponentialBackoff } from '../../../shared/policy/exponential-backoff';
import type { IClock } from '../../../shared/port/clock.port';
import type { IIdGenerator } from '../../../shared/port/id-generator.port';
import type { IUseCase } from '../../../shared/use-case';
import type { Wallet } from '../../../wallet/entity/wallet';
import type { WalletLedgerEntry } from '../../../wallet/entity/wallet-ledger-entry';
import { ReferenceResolver } from '../../domain-service/reference-resolver';
import { WagerSettlement } from '../../domain-service/wager-settlement';
import type { WagerTransaction } from '../../entity/wager-transaction';
import { WagerTransactionStatus } from '../../enum/wager-transaction-status';
import type { IWageringUnitOfWork, TxRepositories } from '../../port/tx-repositories.port';
import { WagerOutcomeEvents } from '../process-wager-transaction/wager-outcome-events';

export interface RetryPendingReferencesConfig {
  readonly batchSize: number;
  /** Quanto tempo um id com claim fica invisível para as outras instâncias enquanto essa trabalha nele. */
  readonly leaseMs: number;
}

export interface RetryPendingReferencesInput {
  /**
   * Checado antes de cada item, quando responde true a rodada termina ali. Os itens que não foram alcançados ficam
   * com lease e attempts intactos, então outra instância faz o retry quando o lease acabar.
   */
  readonly shouldStop?: () => boolean;
}

export type RetryResult = 'processed' | 'rejected' | 'exhausted' | 'rescheduled' | 'failed' | 'skipped';

export interface RetryPendingReferencesOutput {
  readonly claimed: number;
  readonly processed: number;
  readonly rejected: number;
  /** Rejeitados porque as tentativas acabaram (REFERENCE_NOT_FOUND / REFERENCE_NOT_PROCESSED), não entram em `rejected`. */
  readonly exhausted: number;
  readonly rescheduled: number;
  readonly failed: number;
  /** Já decididos por outro (ou sumiram) quando chegou a vez deles. */
  readonly skipped: number;
  /** Itens cuja unit of work lançou erro (ex.: erro transitório do banco), o retry vem depois do lease. */
  readonly erroredIds: readonly string[];
  /** Com claim mas sem tentativa porque pediram para a rodada parar, o retry vem depois do lease. */
  readonly unattemptedIds: readonly string[];
}

/**
 * Worker de pending-reference, sem deadlock entre instâncias:
 * 1. faz claim só dos ids, numa unit of work curta (lease + SKIP LOCKED);
 * 2. roda cada id na própria unit of work, com lock de wallet → transação (mesma ordem do fluxo principal),
 *    checa de novo o status e se a tentativa ainda está vencida, e então resolve e liquida com os mesmos domain
 *    services.
 * As tentativas têm teto pelo backoff: se a última ainda não acha a referência a transação vira
 * REJECTED/REFERENCE_NOT_FOUND (REFERENCE_NOT_PROCESSED quando a referência existe mas nunca foi liquidada) e o
 * evento de rejeição é publicado. Uma inconsistência permanente (sem wallet, invariante quebrada) leva para FAILED.
 */
export class RetryPendingReferences implements IUseCase<RetryPendingReferencesInput | void, RetryPendingReferencesOutput> {
  private readonly settlement = new WagerSettlement();
  private readonly outcomeEvents: WagerOutcomeEvents;

  constructor(
    private readonly unitOfWork: IWageringUnitOfWork,
    private readonly clock: IClock,
    ids: IIdGenerator,
    private readonly backoff: ExponentialBackoff,
    private readonly config: RetryPendingReferencesConfig,
  ) {
    this.outcomeEvents = new WagerOutcomeEvents(ids);
  }

  async execute(input: RetryPendingReferencesInput | void): Promise<RetryPendingReferencesOutput> {
    const shouldStop = input?.shouldStop ?? (() => false);
    const claimedAt = this.clock.now();
    const ids = await this.unitOfWork.run((tx) =>
      tx.wagers.claimPendingBatch({ limit: this.config.batchSize, leaseMs: this.config.leaseMs, now: claimedAt }),
    );
    const counts: Record<RetryResult, number> = {
      processed: 0,
      rejected: 0,
      exhausted: 0,
      rescheduled: 0,
      failed: 0,
      skipped: 0,
    };
    const erroredIds: string[] = [];
    for (const [index, id] of ids.entries()) {
      if (shouldStop()) {
        return { claimed: ids.length, ...counts, erroredIds, unattemptedIds: ids.slice(index) };
      }
      try {
        counts[await this.unitOfWork.run((tx) => this.retry(tx, id, claimedAt))] += 1;
      } catch {
        erroredIds.push(id);
      }
    }
    return { claimed: ids.length, ...counts, erroredIds, unattemptedIds: [] };
  }

  private async retry(tx: TxRepositories, id: string, claimedAt: Date): Promise<RetryResult> {
    const peek = await tx.wagers.findById(id);
    if (peek === null) return 'skipped';
    const wallet = await tx.wallets.lockById(peek.walletId);
    const transaction = await tx.wagers.lockById(id);
    if (transaction === null || transaction.status !== WagerTransactionStatus.PENDING_REFERENCE) return 'skipped';
    // O claim só pega tentativas vencidas em claimedAt. Se a data de vencimento é posterior, esse lease expirou e
    // outra instância pegou o item e já contou essa tentativa, então contar de novo queimaria o backoff.
    const due = transaction.nextAttemptAt;
    if (due !== undefined && due.getTime() > claimedAt.getTime()) return 'skipped';
    const now = this.clock.now();

    if (wallet === null) {
      transaction.fail(FailureCode.WALLET_NOT_FOUND, now);
      await tx.wagers.update(transaction);
      return 'failed';
    }

    const expectedVersion = wallet.version;
    let decision: { result: RetryResult; entry: WalletLedgerEntry | null };
    try {
      decision = await this.decide(tx, transaction, wallet, now);
    } catch (error) {
      // Uma invariante de domínio quebrou na liquidação (bug ou dado corrompido, não resultado de negócio, já que
      // esses, o máximo de Money incluído, voltam como rejeição). O retry nunca vai dar certo, então a transação
      // sai da fila como FAILED com o código persistido mais próximo.
      if (!(error instanceof DomainError) || error instanceof BusinessRuleError) throw error;
      const fresh = await tx.wagers.lockById(id);
      if (fresh === null) throw error;
      fresh.fail(FailureCode.REFERENCE_MISMATCH, now);
      await tx.wagers.update(fresh);
      return 'failed';
    }

    await tx.wagers.update(transaction);
    if (decision.entry !== null) {
      await tx.ledger.append(decision.entry);
      await tx.wallets.update(wallet, expectedVersion);
    }
    if (transaction.isTerminal()) {
      // O correlation id da submissão não é persistido, o retry é uma cadeia causal nova iniciada pelo worker,
      // e o que as duas cadeias têm em comum é o id da transação (ele está em todo evento da transação).
      const events = this.outcomeEvents.toEvents(
        { transaction, wallet, entry: decision.entry },
        { correlationId: transaction.id, occurredAt: now },
      );
      await tx.outbox.add(events.map((event) => OutboxMessage.fromEvent(event)));
    }
    return decision.result;
  }

  private async decide(
    tx: TxRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    now: Date,
  ): Promise<{ result: RetryResult; entry: WalletLedgerEntry | null }> {
    const resolution = await new ReferenceResolver(tx.wagers).resolve(transaction);
    switch (resolution.type) {
      case 'Missing':
      case 'StillPending': {
        const attempt = transaction.attempts + 1;
        if (this.backoff.isExhausted(attempt)) {
          const code =
            resolution.type === 'Missing' ? FailureCode.REFERENCE_NOT_FOUND : FailureCode.REFERENCE_NOT_PROCESSED;
          transaction.reject(code, wallet.balance, now);
          return { result: 'exhausted', entry: null };
        }
        transaction.scheduleNextAttempt(new Date(now.getTime() + this.backoff.nextDelayMs(attempt)));
        return { result: 'rescheduled', entry: null };
      }
      case 'Rejected':
        transaction.attachReference(resolution.reference);
        transaction.reject(resolution.code, wallet.balance, now);
        return { result: 'rejected', entry: null };
      case 'Resolved': {
        const outcome = this.settlement.settle({ transaction, wallet, reference: resolution.reference, at: now });
        return outcome.type === 'Processed'
          ? { result: 'processed', entry: outcome.entry }
          : { result: 'rejected', entry: null };
      }
    }
  }
}
