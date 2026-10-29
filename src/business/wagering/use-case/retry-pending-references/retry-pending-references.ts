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
  /** How long a claimed id stays invisible to other instances while this one works on it. */
  readonly leaseMs: number;
}

export interface RetryPendingReferencesInput {
  /**
   * Checked before each item: once it answers true the round ends there. The items it did not reach keep their lease
   * and attempts untouched, so another instance retries them when the lease ends.
   */
  readonly shouldStop?: () => boolean;
}

export type RetryResult = 'processed' | 'rejected' | 'exhausted' | 'rescheduled' | 'failed' | 'skipped';

export interface RetryPendingReferencesOutput {
  readonly claimed: number;
  readonly processed: number;
  readonly rejected: number;
  /** Rejected because the attempts ran out (REFERENCE_NOT_FOUND / REFERENCE_NOT_PROCESSED); not counted in `rejected`. */
  readonly exhausted: number;
  readonly rescheduled: number;
  readonly failed: number;
  /** Already decided by someone else (or gone) when its turn came. */
  readonly skipped: number;
  /** Items whose unit of work threw (e.g. a transient database error); they are retried after the lease. */
  readonly erroredIds: readonly string[];
  /** Claimed but not attempted because the round was asked to stop; retried after the lease. */
  readonly unattemptedIds: readonly string[];
}

/**
 * Pending-reference worker, deadlock-free across instances:
 * 1. claims only ids, in a short unit of work (lease + SKIP LOCKED);
 * 2. runs each id in its own unit of work, locking wallet → transaction (the same order as the main flow),
 *    re-checking the status and that the attempt is still due, then resolving and settling with the same domain
 *    services.
 * Attempts are capped by the backoff: when the last one still finds no reference the transaction is
 * REJECTED/REFERENCE_NOT_FOUND (REFERENCE_NOT_PROCESSED when the reference exists but never settled) and the
 * rejection event is published. A permanent inconsistency (no wallet, broken invariant) moves it to FAILED.
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
    // The claim only picks attempts due at claimedAt. A later due date means this lease expired and another
    // instance reclaimed the item and already counted this attempt: counting it again would burn the backoff.
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
      // A domain invariant broke while settling (e.g. the credit would overflow the Money maximum): retrying can
      // never succeed, so the transaction leaves the queue as FAILED with the closest of the persisted codes.
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
      // The submission's correlation id is not persisted: the retry is a new causal chain started by the worker,
      // and the transaction id is what both chains share (it is in every event of the transaction).
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
