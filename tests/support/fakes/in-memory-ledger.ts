import type { WalletLedgerEntry } from '../../../src/business/wallet/entity/wallet-ledger-entry';
import type { ILedgerReader, LedgerPage, LedgerPageQuery } from '../../../src/business/wallet/port/ledger-reader.port';
import type { ILedgerWriter } from '../../../src/business/wallet/port/ledger-writer.port';
import { UniqueConstraintViolationError } from '../../../src/business/shared/error/unique-constraint-violation-error';
import { LedgerCursor } from '../../../src/business/wallet/value-object/ledger-cursor';
import type { UndoLog } from './undo-log';

export class LedgerConstraintError extends Error {
  constructor(constraint: string) {
    super(`Ledger constraint violated: ${constraint}`);
    this.name = 'LedgerConstraintError';
  }
}

/**
 * Ledger só de insert com as mesmas garantias de unicidade do schema e um seq tipo bigserial.
 * Igual a uma sequence do Postgres, um append que sofreu rollback ainda consome o seq dele.
 */
export class InMemoryLedger implements ILedgerWriter, ILedgerReader {
  private readonly entries: WalletLedgerEntry[] = [];
  private lastSeq = 0n;

  async append(entry: WalletLedgerEntry): Promise<WalletLedgerEntry> {
    if (this.entries.some((existing) => existing.transactionId === entry.transactionId)) {
      throw new UniqueConstraintViolationError('UNIQUE(transaction_id)');
    }
    if (
      this.entries.some(
        (existing) => existing.walletId === entry.walletId && existing.walletVersion === entry.walletVersion,
      )
    ) {
      throw new UniqueConstraintViolationError('UNIQUE(wallet_id, wallet_version)');
    }
    if (!entry.isBalanced()) throw new LedgerConstraintError('CHECK arithmetic');
    this.lastSeq += 1n;
    const persisted = entry.withSeq(this.lastSeq);
    this.entries.push(persisted);
    return persisted;
  }

  async page({ walletId, after, limit }: LedgerPageQuery): Promise<LedgerPage> {
    const afterSeq = after?.seq ?? 0n;
    const matching = this.entries.filter((entry) => entry.walletId === walletId && (entry.seq ?? 0n) > afterSeq);
    const entries = matching.slice(0, limit);
    const last = entries.at(-1);
    const next = matching.length > limit && last?.seq !== undefined ? LedgerCursor.afterSeq(last.seq) : null;
    return { entries, next };
  }

  async listAll(walletId: string): Promise<WalletLedgerEntry[]> {
    return this.entries.filter((entry) => entry.walletId === walletId);
  }

  /** View presa a uma unit of work: um rollback remove o que ela adicionou. */
  withUndo(undo: UndoLog): ILedgerWriter & ILedgerReader {
    return {
      append: async (entry) => {
        const persisted = await this.append(entry);
        undo.record(() => this.remove(persisted.transactionId));
        return persisted;
      },
      page: (query) => this.page(query),
      listAll: (walletId) => this.listAll(walletId),
    };
  }

  private remove(transactionId: string): void {
    const index = this.entries.findIndex((entry) => entry.transactionId === transactionId);
    if (index >= 0) this.entries.splice(index, 1);
  }

  count(): number {
    return this.entries.length;
  }
}
