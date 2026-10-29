import { beforeEach, describe, expect, it } from 'bun:test';
import { aSubmission, createFakeWageringApp, type FakeWageringApp } from '../../../../../tests/support/fakes/fake-wagering-app';
import { InvalidRequestError } from '../../../shared/error/invalid-request-error';
import { WagerTransactionNotFoundError } from '../../error/wager-transaction-not-found-error';
import { aPlayerId } from '../../../../../tests/support/fakes/sequential-id-generator';

describe('GetWagerTransaction', () => {
  let app: FakeWageringApp;

  beforeEach(() => {
    app = createFakeWageringApp();
  });

  it('finds a transaction by internal id and by the provider external id', async () => {
    const wallet = await app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: { amount: '100.00', currency: 'BRL' } });
    const { transactionId } = await app.process.execute(aSubmission(wallet, 'BET', 'bet', { amount: '25.00' }));

    const byId = await app.getTransaction.execute({ transactionId });
    expect(byId).toEqual({
      transactionId,
      providerId: 'provider-a',
      externalTransactionId: 'bet',
      walletId: wallet.id,
      playerId: aPlayerId(1),
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      status: 'PROCESSED',
      failureCode: null,
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      balance: { amount: '75.00', currency: 'BRL' },
      attempts: 0,
      nextAttemptAt: null,
      createdAt: app.clock.now().toISOString(),
      processedAt: app.clock.now().toISOString(),
    });
    expect(await app.getTransaction.execute({ providerId: 'provider-a', externalTransactionId: 'bet' })).toEqual(byId);
  });

  it('shows a pending transaction with its schedule', async () => {
    const wallet = await app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: { amount: '1.00', currency: 'BRL' } });
    const { transactionId } = await app.process.execute(aSubmission(wallet, 'REFUND', 'refund', { reference: 'bet' }));
    expect(await app.getTransaction.execute({ transactionId })).toMatchObject({
      status: 'PENDING_REFERENCE',
      referenceExternalTransactionId: 'bet',
      balance: null,
      attempts: 1,
      nextAttemptAt: new Date(app.clock.now().getTime() + 1_000).toISOString(),
    });
  });

  it('answers not found, and scopes the external id by provider', async () => {
    const wallet = await app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: { amount: '10.00', currency: 'BRL' } });
    await app.process.execute(aSubmission(wallet, 'BET', 'bet'));
    await expect(app.getTransaction.execute({ transactionId: 'ghost' })).rejects.toBeInstanceOf(WagerTransactionNotFoundError);
    await expect(
      app.getTransaction.execute({ providerId: 'provider-b', externalTransactionId: 'bet' }),
    ).rejects.toBeInstanceOf(WagerTransactionNotFoundError);
  });

  it.each([{ transactionId: ' ' }, { providerId: '', externalTransactionId: 'bet' }, { providerId: 'p', externalTransactionId: '' }])(
    'rejects blank identifiers %p',
    async (input) => {
      await expect(app.getTransaction.execute(input)).rejects.toBeInstanceOf(InvalidRequestError);
    },
  );
});
