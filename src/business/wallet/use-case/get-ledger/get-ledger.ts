import { InvalidRequestError } from '../../../shared/error/invalid-request-error';
import { WalletNotFoundError } from '../../../shared/error/wallet-not-found-error';
import type { IUseCase } from '../../../shared/use-case';
import type { ILedgerReader } from '../../port/ledger-reader.port';
import type { IWalletRepository } from '../../port/wallet.repository.port';
import { LedgerCursor } from '../../value-object/ledger-cursor';
import { type LedgerEntryView, toLedgerEntryView } from '../wallet-view';

export interface GetLedgerInput {
  readonly walletId: string;
  /** Token opaco de uma página anterior, ausente na primeira página. */
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface GetLedgerOutput {
  readonly walletId: string;
  readonly entries: readonly LedgerEntryView[];
  /** Null na última página. */
  readonly nextCursor: string | null;
}

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

/** Paginação estável por seq: entries adicionadas durante a paginação caem depois do cursor, então nenhuma é pulada ou repetida. */
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
