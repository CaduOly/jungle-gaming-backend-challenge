import type { WalletLedgerEntry } from '../../../src/business/wallet/entity/wallet-ledger-entry';
import type { ILedgerReader, LedgerPage, LedgerPageQuery } from '../../../src/business/wallet/port/ledger-reader.port';
import type { ILedgerWriter } from '../../../src/business/wallet/port/ledger-writer.port';
import { LedgerCursor } from '../../../src/business/wallet/value-object/ledger-cursor';

export class LedgerConstraintError extends Error {
  constructor(constraint: string) {
    super(`Ledger constraint violated: ${constraint}`);
    this.name = 'LedgerConstraintError';
  }
}

/** Insert-only ledger with the same uniqueness guarantees as the schema and a bigserial-like seq. */
export class InMemoryLedger implements ILedgerWriter, ILedgerReader {
  private readonly entries: WalletLedgerEntry[] = [];
  private lastSeq = 0n;

  async append(entry: WalletLedgerEntry): Promise<WalletLedgerEntry> {
    if (this.entries.some((existing) => existing.transactionId === entry.transactionId)) {
      throw new LedgerConstraintError('UNIQUE(transaction_id)');
    }
    if (
      this.entries.some(
        (existing) => existing.walletId === entry.walletId && existing.walletVersion === entry.walletVersion,
      )
    ) {
      throw new LedgerConstraintError('UNIQUE(wallet_id, wallet_version)');
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

  count(): number {
    return this.entries.length;
  }
}
