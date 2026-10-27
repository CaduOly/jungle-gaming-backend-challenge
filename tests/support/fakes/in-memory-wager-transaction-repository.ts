import {
  WagerTransaction,
  type WagerTransactionState,
} from '../../../src/business/wagering/entity/wager-transaction';
import type {
  ClaimPendingBatch,
  IWagerTransactionRepository,
} from '../../../src/business/wagering/port/wager-transaction.repository.port';
import { UniqueConstraintViolationError } from '../../../src/business/shared/error/unique-constraint-violation-error';
import { KeyedMutex, type Release } from './keyed-mutex';
import type { UndoLog } from './undo-log';

export class WagerConstraintError extends Error {
  constructor(readonly constraint: string) {
    super(`Wager transaction constraint violated: ${constraint}`);
    this.name = 'WagerConstraintError';
  }
}

const REVERSAL_KINDS = new Set(['REFUND', 'ROLLBACK']);

export interface Row {
  state: WagerTransactionState;
  lockedUntil: Date | null;
}

/**
 * Shared "table" with the schema's unique constraints (raised as UniqueConstraintViolationError, the way the
 * adapter maps 23505), terminal-status guard and row locks.
 */
export class InMemoryWagerTransactionStore {
  readonly locks = new KeyedMutex();
  readonly rows = new Map<string, Row>();

  read(id: string): WagerTransaction | null {
    const row = this.rows.get(id);
    return row === undefined ? null : WagerTransaction.rehydrate(row.state);
  }

  find(predicate: (state: WagerTransactionState) => boolean): WagerTransaction | null {
    for (const row of this.rows.values()) if (predicate(row.state)) return WagerTransaction.rehydrate(row.state);
    return null;
  }

  write(transaction: WagerTransaction): void {
    const state = transaction.toState();
    this.assertUnique(state);
    const existing = this.rows.get(state.id);
    this.rows.set(state.id, { state, lockedUntil: existing?.lockedUntil ?? null });
  }

  /** Puts a row back as it was (or removes it when it did not exist): the rollback of a write. */
  restore(id: string, row: Row | undefined): void {
    if (row === undefined) this.rows.delete(id);
    else this.rows.set(id, { ...row });
  }

  all(): WagerTransaction[] {
    return [...this.rows.values()].map((row) => WagerTransaction.rehydrate(row.state));
  }

  private assertUnique(state: WagerTransactionState): void {
    for (const { state: other } of this.rows.values()) {
      if (other.id === state.id) continue;
      if (other.providerId === state.providerId && other.idempotencyKey === state.idempotencyKey) {
        throw new UniqueConstraintViolationError('UNIQUE(provider_id, idempotency_key)');
      }
      if (other.providerId === state.providerId && other.externalTransactionId === state.externalTransactionId) {
        throw new UniqueConstraintViolationError('UNIQUE(provider_id, external_transaction_id)');
      }
      const bothProcessedReversals = [other, state].every(
        (row) => row.status === 'PROCESSED' && REVERSAL_KINDS.has(row.kind),
      );
      if (
        bothProcessedReversals &&
        state.referenceTransactionId !== undefined &&
        other.referenceTransactionId === state.referenceTransactionId
      ) {
        throw new UniqueConstraintViolationError('UNIQUE(reference_transaction_id) WHERE processed reversal');
      }
    }
  }
}

/**
 * Repository scoped to one unit of work; `releaseLocks()` is called by the fake unit of work.
 * Like the schema trigger, an update cannot move a row out of a terminal status.
 */
export class InMemoryWagerTransactionRepository implements IWagerTransactionRepository {
  private readonly held = new Map<string, Promise<Release>>();

  constructor(
    private readonly store: InMemoryWagerTransactionStore,
    private readonly undo?: UndoLog,
  ) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    return this.store.read(id);
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null> {
    return this.store.find((row) => row.providerId === providerId && row.idempotencyKey === idempotencyKey);
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.store.find(
      (row) => row.providerId === providerId && row.externalTransactionId === externalTransactionId,
    );
  }

  async lockById(id: string): Promise<WagerTransaction | null> {
    if (!this.store.rows.has(id)) return null;
    let acquisition = this.held.get(id);
    if (acquisition === undefined) {
      acquisition = this.store.locks.acquire(id);
      this.held.set(id, acquisition);
    }
    await acquisition;
    return this.store.read(id);
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    if (this.store.rows.has(transaction.id)) throw new WagerConstraintError('PRIMARY KEY(id)');
    if (transaction.status === 'PENDING') throw new Error('PENDING transactions are never persisted');
    this.store.write(transaction);
    this.journal(transaction.id, undefined);
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const current = this.store.read(transaction.id);
    if (current === null) throw new Error(`Wager transaction ${transaction.id} not found`);
    if (current.isTerminal()) throw new WagerConstraintError('terminal status is immutable');
    const before = this.store.rows.get(transaction.id);
    this.store.write(transaction);
    this.journal(transaction.id, before && { ...before });
  }

  async isReversed(referenceTransactionId: string): Promise<boolean> {
    return (
      this.store.find(
        (row) =>
          row.referenceTransactionId === referenceTransactionId &&
          row.status === 'PROCESSED' &&
          REVERSAL_KINDS.has(row.kind),
      ) !== null
    );
  }

  async claimPendingBatch({ limit, leaseMs, now }: ClaimPendingBatch): Promise<string[]> {
    const due = [...this.store.rows.values()]
      .filter(
        ({ state, lockedUntil }) =>
          state.status === 'PENDING_REFERENCE' &&
          (state.nextAttemptAt === undefined || state.nextAttemptAt <= now) &&
          (lockedUntil === null || lockedUntil <= now) &&
          !this.store.locks.isLocked(state.id),
      )
      .sort((a, b) => (a.state.nextAttemptAt?.getTime() ?? 0) - (b.state.nextAttemptAt?.getTime() ?? 0))
      .slice(0, limit);
    const leaseEnd = new Date(now.getTime() + leaseMs);
    for (const row of due) {
      this.journal(row.state.id, { ...row });
      row.lockedUntil = leaseEnd;
    }
    return due.map((row) => row.state.id);
  }

  private journal(id: string, before: Row | undefined): void {
    this.undo?.record(() => this.store.restore(id, before));
  }

  async releaseLocks(): Promise<void> {
    const acquisitions = [...this.held.values()];
    this.held.clear();
    for (const release of await Promise.all(acquisitions)) release();
  }
}
