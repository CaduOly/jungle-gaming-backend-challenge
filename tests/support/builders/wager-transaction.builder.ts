import { Money } from '../../../src/business/shared/value-object/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../../../src/business/wagering/entity/wager-transaction';
import type { WagerKind } from '../../../src/business/wagering/enum/wager-kind';

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });
export const T0 = new Date('2026-01-01T00:00:00.000Z');

export const wagerProps = (
  kind: WagerKind,
  externalTransactionId: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps => ({
  id: `id-${externalTransactionId}`,
  providerId: 'provider-1',
  idempotencyKey: `key-${externalTransactionId}`,
  externalTransactionId,
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind,
  money: brl('10.00'),
  payloadHash: `hash-${externalTransactionId}`,
  createdAt: T0,
  ...overrides,
});

export const aWager = (
  kind: WagerKind,
  externalTransactionId: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction => WagerTransaction.create(wagerProps(kind, externalTransactionId, overrides));

export const aProcessedWager = (
  kind: WagerKind,
  externalTransactionId: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction => {
  const transaction = aWager(kind, externalTransactionId, overrides);
  transaction.markProcessed(brl('100.00'), T0);
  return transaction;
};
