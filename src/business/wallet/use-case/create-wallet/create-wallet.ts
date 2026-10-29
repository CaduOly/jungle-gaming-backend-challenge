import { OutboxMessage } from '../../../messaging/entity/outbox-message';
import { DomainError } from '../../../shared/error/domain-error';
import { InvalidRequestError } from '../../../shared/error/invalid-request-error';
import { UniqueConstraintViolationError } from '../../../shared/error/unique-constraint-violation-error';
import type { IClock } from '../../../shared/port/clock.port';
import type { IIdGenerator } from '../../../shared/port/id-generator.port';
import type { IUseCase } from '../../../shared/use-case';
import { Money, type MoneyProps } from '../../../shared/value-object/money';
import { WagerTransaction } from '../../../wagering/entity/wager-transaction';
import { WagerKind } from '../../../wagering/enum/wager-kind';
import type { IPayloadHasher } from '../../../wagering/port/payload-hasher.port';
import type { IWageringUnitOfWork } from '../../../wagering/port/tx-repositories.port';
import { Wallet } from '../../entity/wallet';
import { WalletAlreadyExistsError } from '../../error/wallet-already-exists-error';
import { WalletBalanceChanged } from '../../event/wallet-balance-changed.event';
import { toWalletView, type WalletView } from '../wallet-view';

export interface CreateWalletInput {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
  readonly correlationId?: string;
}

export const SYSTEM_PROVIDER_ID = 'system';
const MAX_TEXT_LENGTH = 255;

export const openingIdempotencyKey = (walletId: string): string => `opening:${walletId}`;

/**
 * Opens a wallet at version 1. A positive initial balance also writes, in the same unit of work, the internal
 * OPENING transaction (provider `system`, key `opening:<walletId>`), its CREDIT entry and WalletBalanceChanged.
 * One wallet per player and currency, guaranteed by the unique constraint alone (no read-then-insert race):
 * the violation becomes the 409 conflict.
 */
export class CreateWallet implements IUseCase<CreateWalletInput, WalletView> {
  constructor(
    private readonly unitOfWork: IWageringUnitOfWork,
    private readonly hasher: IPayloadHasher,
    private readonly clock: IClock,
    private readonly ids: IIdGenerator,
  ) {}

  async execute(input: CreateWalletInput): Promise<WalletView> {
    const { playerId } = input;
    if (typeof playerId !== 'string' || playerId.trim() === '' || playerId.length > MAX_TEXT_LENGTH) {
      throw new InvalidRequestError('playerId', `must be a non-blank string of at most ${MAX_TEXT_LENGTH} characters`);
    }
    if (playerId.trim() !== playerId) throw new InvalidRequestError('playerId', 'must not start or end with whitespace');
    const initialBalance = this.parseMoney(input.initialBalance);

    try {
      return await this.unitOfWork.run(async (tx) => {
        const now = this.clock.now();
        const walletId = this.ids.generate();
        const openingId = initialBalance.isZero() ? undefined : this.ids.generate();
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId,
          initialBalance,
          at: now,
          ...(openingId === undefined ? {} : { openingTransactionId: openingId }),
        });
        await tx.wallets.insert(wallet);
        if (openingEntry !== null && openingId !== undefined) {
          await tx.wagers.insert(this.openingTransaction(openingId, wallet, now));
          await tx.ledger.append(openingEntry);
          const event = WalletBalanceChanged.from(wallet, openingEntry, {
            eventId: this.ids.generate(),
            correlationId: input.correlationId ?? walletId,
            occurredAt: now,
          });
          await tx.outbox.add([OutboxMessage.fromEvent(event)]);
        }
        return toWalletView(wallet);
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationError) {
        throw new WalletAlreadyExistsError(playerId, initialBalance.currency);
      }
      throw error;
    }
  }

  private parseMoney(money: MoneyProps): Money {
    try {
      return Money.from(money);
    } catch (error) {
      if (error instanceof DomainError || error instanceof TypeError) {
        throw new InvalidRequestError('initialBalance', String(error));
      }
      throw error;
    }
  }

  private openingTransaction(id: string, wallet: Wallet, now: Date): WagerTransaction {
    const key = openingIdempotencyKey(wallet.id);
    const opening = WagerTransaction.create({
      id,
      providerId: SYSTEM_PROVIDER_ID,
      idempotencyKey: key,
      externalTransactionId: key,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: key,
      gameId: SYSTEM_PROVIDER_ID,
      kind: WagerKind.OPENING,
      money: wallet.balance,
      payloadHash: this.hasher.hash({
        providerId: SYSTEM_PROVIDER_ID,
        externalTransactionId: key,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: key,
        gameId: SYSTEM_PROVIDER_ID,
        kind: WagerKind.OPENING,
        money: wallet.balance.toProps(),
        referenceExternalTransactionId: null,
      }),
      createdAt: now,
    });
    opening.markProcessed(wallet.balance, now);
    return opening;
  }
}
