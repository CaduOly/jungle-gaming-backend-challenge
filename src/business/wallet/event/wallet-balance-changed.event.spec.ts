import { describe, expect, it } from 'bun:test';
import { Money } from '../../shared/value-object/money';
import { Wallet } from '../entity/wallet';
import { LedgerEntryType } from '../enum/ledger-entry-type';
import { InvalidLedgerEntryError } from '../error/invalid-ledger-entry-error';
import { WalletBalanceChanged } from './wallet-balance-changed.event';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-07-29T15:00:00.000Z');
const context = { eventId: 'evt-1', correlationId: 'corr-1', causationId: 'msg-1', occurredAt: at };

describe('WalletBalanceChanged', () => {
  it('describes the OPENING entry as plain JSON at walletVersion 1', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('1000.00'),
      openingTransactionId: 'opening-tx',
      at,
    });
    const event = WalletBalanceChanged.from(wallet, openingEntry!, context);

    expect(event.toJSON()).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      version: 1,
      aggregateType: 'Wallet',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      data: {
        walletId: 'wallet-1',
        playerId: 'player-1',
        transactionId: 'opening-tx',
        entryType: 'OPENING',
        direction: 'CREDIT',
        money: { amount: '1000.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '1000.00', currency: 'BRL' },
        walletVersion: 1,
      },
    });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  it('carries the version of the movement it describes', () => {
    const { wallet } = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl('0.00'), at });
    const entry = wallet.credit({ transactionId: 'win', entryType: LedgerEntryType.WIN, amount: brl('5.00'), at });
    const event = WalletBalanceChanged.from(wallet, entry, context);
    expect(event.data.walletVersion).toBe(2);
    expect(event.data.balanceAfter).toEqual({ amount: '5.00', currency: 'BRL' });
  });

  it('refuses an entry of another wallet', () => {
    const { wallet } = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl('0.00'), at });
    const { openingEntry } = Wallet.open({
      id: 'wallet-2',
      playerId: 'player-1',
      initialBalance: brl('1.00'),
      openingTransactionId: 'o',
      at,
    });
    expect(() => WalletBalanceChanged.from(wallet, openingEntry!, context)).toThrow(InvalidLedgerEntryError);
  });
});
