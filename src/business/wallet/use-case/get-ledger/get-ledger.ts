import { InvalidRequestError } from '../../../shared/error/invalid-request-error';
import { WalletNotFoundError } from '../../../shared/error/wallet-not-found-error';
import type { IUseCase } from '../../../shared/use-case';
import type { ILedgerReader } from '../../port/ledger-reader.port';
import type { IWalletRepository } from '../../port/wallet.repository.port';
import { LedgerCursor } from '../../value-object/ledger-cursor';
import { type LedgerEntryView, toLedgerEntryView } from '../wallet-view';

export interface GetLedgerInput {
  readonly walletId: string;
  /** Opaque token from a previous page; absent for the first page. */
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface GetLedgerOutput {
  readonly walletId: string;
  readonly entries: readonly LedgerEntryView[];
  /** Null on the last page. */
  readonly nextCursor: string | null;
}

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

/** Stable pagination by seq: entries appended while paging land after the cursor, so none is skipped or repeated. */
export class GetLedger implements IUseCase<GetLedgerInput, GetLedgerOutput> {
  constructor(
    private readonly wallets: Pick<IWalletRepository, 'findById'>,
    private readonly ledger: Pick<ILedgerReader, 'page'>,
  ) {}

  async execute(input: GetLedgerInput): Promise<GetLedgerOutput> {
    const limit = input.limit ?? DEFAULT_LEDGER_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LEDGER_LIMIT) {
      throw new InvalidRequestError('limit', `must be an integer between 1 and ${MAX_LEDGER_LIMIT}`);
    }
    const after = input.cursor === undefined || input.cursor === null ? null : LedgerCursor.decode(input.cursor);
    if ((await this.wallets.findById(input.walletId)) === null) throw new WalletNotFoundError(input.walletId);
    const page = await this.ledger.page({ walletId: input.walletId, after, limit });
    return {
      walletId: input.walletId,
      entries: page.entries.map(toLedgerEntryView),
      nextCursor: page.next?.encode() ?? null,
    };
  }
}
