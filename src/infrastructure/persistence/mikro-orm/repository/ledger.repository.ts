import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletLedgerEntry } from '../../../../business/wallet/entity/wallet-ledger-entry';
import type { ILedgerReader, LedgerPage, LedgerPageQuery } from '../../../../business/wallet/port/ledger-reader.port';
import type { ILedgerWriter } from '../../../../business/wallet/port/ledger-writer.port';
import { LedgerCursor } from '../../../../business/wallet/value-object/ledger-cursor';
import { FaultInjector } from '../../../fault-injection/fault-injector';
import { LEDGER_SELECT, ledgerEntryFromRow, type LedgerEntryRow, ledgerEntryToInsertParams } from '../mapper/ledger-entry.mapper';
import { isUuid, toBigInt } from '../mapper/sql-values';

/** Insert-only (the table triggers reject UPDATE, DELETE and TRUNCATE); pages follow seq, never offsets. */
export class LedgerRepository implements ILedgerWriter, ILedgerReader {
  constructor(
    private readonly em: EntityManager,
    private readonly faults: FaultInjector = FaultInjector.none(),
  ) {}

  async append(entry: WalletLedgerEntry): Promise<WalletLedgerEntry> {
    this.faults.trip('fail_ledger_insert');
    const [row] = await this.em.execute<{ seq: unknown }[]>(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version,
          created_at)
       VALUES (gen_random_uuid(), ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING seq`,
      ledgerEntryToInsertParams(entry),
    );
    if (row === undefined) throw new Error(`Ledger entry of transaction ${entry.transactionId} was not inserted`);
    return entry.withSeq(toBigInt(row.seq));
  }

  async page({ walletId, after, limit }: LedgerPageQuery): Promise<LedgerPage> {
    if (!isUuid(walletId)) return { entries: [], next: null };
    const rows = await this.em.execute<LedgerEntryRow[]>(
      `${LEDGER_SELECT} WHERE l.wallet_id = ? AND l.seq > ? ORDER BY l.seq LIMIT ?`,
      [walletId, (after?.seq ?? 0n).toString(), limit + 1],
    );
    const entries = rows.slice(0, limit).map(ledgerEntryFromRow);
    const last = entries.at(-1);
    const next = rows.length > limit && last?.seq !== undefined ? LedgerCursor.afterSeq(last.seq) : null;
    return { entries, next };
  }

  async listAll(walletId: string): Promise<WalletLedgerEntry[]> {
    if (!isUuid(walletId)) return [];
    const rows = await this.em.execute<LedgerEntryRow[]>(`${LEDGER_SELECT} WHERE l.wallet_id = ? ORDER BY l.seq`, [
      walletId,
    ]);
    return rows.map(ledgerEntryFromRow);
  }
}
