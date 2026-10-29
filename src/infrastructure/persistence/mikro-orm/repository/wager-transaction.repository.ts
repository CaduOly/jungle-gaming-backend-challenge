import type { EntityManager } from '@mikro-orm/postgresql';
import type { IClock } from '../../../../business/shared/port/clock.port';
import type { WagerTransaction } from '../../../../business/wagering/entity/wager-transaction';
import type {
  ClaimPendingBatch,
  IWagerTransactionRepository,
} from '../../../../business/wagering/port/wager-transaction.repository.port';
import { isUuid } from '../mapper/sql-values';
import {
  processedAtColumn,
  WAGER_INSERT_COLUMNS,
  WAGER_SELECT,
  wagerTransactionFromRow,
  wagerTransactionToInsertParams,
  type WagerTransactionSelectRow,
} from '../mapper/wager-transaction.mapper';
import type { RunResult } from './run-result';

const INSERT_PLACEHOLDERS = Array.from({ length: WAGER_INSERT_COLUMNS.split(',').length }, () => '?').join(', ');

/**
 * Native SQL over wager_transactions. Inserts write the whole row; updates touch only the columns the trigger
 * lets change (status, decision, reference link, retry bookkeeping) and always release the claim lease.
 * `now` is always the application clock, never the database one.
 */
export class WagerTransactionRepository implements IWagerTransactionRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly clock: IClock,
  ) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    if (!isUuid(id)) return null;
    return this.selectOne('WHERE t.id = ?', [id]);
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null> {
    return this.selectOne('WHERE t.provider_id = ? AND t.idempotency_key = ?', [providerId, idempotencyKey]);
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.selectOne('WHERE t.provider_id = ? AND t.external_transaction_id = ?', [
      providerId,
      externalTransactionId,
    ]);
  }

  async lockById(id: string): Promise<WagerTransaction | null> {
    if (!isUuid(id)) return null;
    return this.selectOne('WHERE t.id = ? FOR UPDATE OF t', [id]);
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.execute(
      `INSERT INTO wager_transactions (${WAGER_INSERT_COLUMNS}) VALUES (${INSERT_PLACEHOLDERS})`,
      wagerTransactionToInsertParams(transaction),
      'run',
    );
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const result = await this.em.execute<RunResult>(
      `UPDATE wager_transactions
          SET status = ?, failure_code = ?, observed_balance = ?, reference_transaction_id = ?, attempts = ?,
              next_attempt_at = ?, processed_at = ?, locked_until = NULL, updated_at = ?
        WHERE id = ?`,
      [
        transaction.status,
        transaction.failureCode ?? null,
        transaction.observedBalance?.amount ?? null,
        transaction.referenceTransactionId ?? null,
        transaction.attempts,
        transaction.nextAttemptAt ?? null,
        processedAtColumn(transaction),
        transaction.processedAt ?? this.clock.now(),
        transaction.id,
      ],
      'run',
    );
    if (result.affectedRows !== 1) throw new Error(`Wager transaction ${transaction.id} does not exist`);
  }

  async isReversed(referenceTransactionId: string): Promise<boolean> {
    if (!isUuid(referenceTransactionId)) return false;
    const [row] = await this.em.execute<{ reversed: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM wager_transactions
          WHERE reference_transaction_id = ? AND status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
       ) AS reversed`,
      [referenceTransactionId],
    );
    return row?.reversed === true;
  }

  async claimPendingBatch({ limit, leaseMs, now }: ClaimPendingBatch): Promise<string[]> {
    const rows = await this.em.execute<{ id: string }[]>(
      `WITH claimed AS (
         UPDATE wager_transactions
            SET locked_until = ?
          WHERE id IN (
                  SELECT id
                    FROM wager_transactions
                   WHERE status = 'PENDING_REFERENCE'
                     AND next_attempt_at <= ?
                     AND (locked_until IS NULL OR locked_until <= ?)
                   ORDER BY next_attempt_at, id
                   LIMIT ?
                     FOR UPDATE SKIP LOCKED)
        RETURNING id, next_attempt_at)
       SELECT id FROM claimed ORDER BY next_attempt_at, id`,
      [new Date(now.getTime() + leaseMs), now, now, limit],
    );
    return rows.map((row) => row.id);
  }

  private async selectOne(where: string, params: unknown[]): Promise<WagerTransaction | null> {
    const [row] = await this.em.execute<WagerTransactionSelectRow[]>(`${WAGER_SELECT} ${where}`, params);
    return row === undefined ? null : wagerTransactionFromRow(row);
  }
}
