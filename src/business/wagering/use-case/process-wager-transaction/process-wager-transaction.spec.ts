import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { assertEveryFakeWalletConsistent } from '../../../../../tests/support/assertions/assert-fake-wallet-consistency';
import { InjectedFaultError } from '../../../../../tests/support/fakes/fake-unit-of-work';
import {
  aSubmission,
  createFakeWageringApp,
  type FakeWageringApp,
  type SubmissionOptions,
  type WalletView,
} from '../../../../../tests/support/fakes/fake-wagering-app';
import { InvalidRequestError } from '../../../shared/error/invalid-request-error';
import { UniqueConstraintViolationError } from '../../../shared/error/unique-constraint-violation-error';
import { WalletNotFoundError } from '../../../shared/error/wallet-not-found-error';
import { Money } from '../../../shared/value-object/money';
import { WagerTransaction } from '../../entity/wager-transaction';
import { WagerKind } from '../../enum/wager-kind';
import { IdempotencyConflictError } from '../../error/idempotency-conflict-error';
import { ProviderIdentityMismatchError } from '../../error/provider-identity-mismatch-error';
import { aPlayerId } from '../../../../../tests/support/fakes/sequential-id-generator';

const SQS = (messageId: string) => ({ channel: 'SQS', consumerName: 'wager-consumer', messageId }) as const;

describe('ProcessWagerTransaction', () => {
  let app: FakeWageringApp;

  beforeEach(() => {
    app = createFakeWageringApp();
  });

  afterEach(async () => {
    await assertEveryFakeWalletConsistent(app.db);
  });

  const open = (balance = '1000.00', playerId = aPlayerId(1)): Promise<WalletView> =>
    app.createWallet.execute({ playerId, initialBalance: { amount: balance, currency: 'BRL' } });
  const submit = (wallet: WalletView, kind: string, ext: string, options: SubmissionOptions = {}) =>
    app.process.execute(aSubmission(wallet, kind, ext, options));
  const balanceOf = (wallet: WalletView): string | undefined => app.db.wallets.read(wallet.id)?.balance.amount;
  const eventTypes = (): string[] => app.db.outbox.all().map((message) => message.eventType);
  const wagerCount = (): number => app.db.wagers.all().filter((transaction) => !transaction.isOpening).length;

  describe('a new BET', () => {
    it('debits, persists, emits Processed + WalletBalanceChanged and answers the README §9 payload', async () => {
      const wallet = await open();
      const result = await submit(wallet, 'BET', 'tx-123', { amount: '25.00' });

      expect(result).toEqual({
        transactionId: expect.any(String),
        kind: 'BET',
        status: 'PROCESSED',
        failureCode: null,
        balance: { amount: '975.00', currency: 'BRL' },
        idempotentReplay: false,
        channel: 'HTTP',
      });
      expect(balanceOf(wallet)).toBe('975.00');
      const stored = app.db.wagers.read(result.transactionId)!;
      expect(stored.status).toBe('PROCESSED');
      expect(stored.idempotencyKey).toBe('provider-a:tx-123');
      expect(stored.observedBalance?.amount).toBe('975.00');
      expect(eventTypes()).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed', 'WalletBalanceChanged']);
      const [, processed, changed] = app.db.outbox.all();
      expect(processed?.aggregateId).toBe(wallet.id);
      expect(changed?.payload.data).toMatchObject({ transactionId: result.transactionId, walletVersion: 2 });
    });

    it('hashes the normalized business fields only (not the key or the transport)', async () => {
      const wallet = await open();
      const result = await submit(wallet, 'BET', 'tx-1', { amount: '25.00' });
      expect(JSON.parse(app.db.wagers.read(result.transactionId)!.payloadHash)).toEqual({
        externalTransactionId: 'tx-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        playerId: aPlayerId(1),
        providerId: 'provider-a',
        referenceExternalTransactionId: null,
        roundId: 'round-1',
        walletId: wallet.id,
      });
    });
  });

  describe('business rules (README §7) end to end', () => {
    it('WIN credits, with the BET of the round as an optional reference', async () => {
      const wallet = await open('100.00');
      await submit(wallet, 'BET', 'bet', { amount: '10.00' });
      const win = await submit(wallet, 'WIN', 'win', { amount: '30.00', reference: 'bet' });
      const loose = await submit(wallet, 'WIN', 'win-2', { amount: '1.00' });
      expect([win.status, loose.status]).toEqual(['PROCESSED', 'PROCESSED']);
      expect(app.db.wagers.read(win.transactionId)?.referenceTransactionId).toBeDefined();
      expect(balanceOf(wallet)).toBe('121.00');
    });

    it('LOSS records the result without moving the balance or writing the ledger', async () => {
      const wallet = await open('100.00');
      await submit(wallet, 'BET', 'bet', { amount: '10.00' });
      const ledgerBefore = app.db.ledger.count();
      const loss = await submit(wallet, 'LOSS', 'loss', { amount: '0.00', reference: 'bet' });
      expect(loss).toMatchObject({ status: 'PROCESSED', balance: { amount: '90.00', currency: 'BRL' } });
      expect(app.db.ledger.count()).toBe(ledgerBefore);
      expect(eventTypes().at(-1)).toBe('WagerTransactionProcessed');
    });

    it('REFUND credits a BET back once; any second reversal is ALREADY_REVERSED', async () => {
      const wallet = await open('100.00');
      await submit(wallet, 'BET', 'bet', { amount: '40.00' });
      const refund = await submit(wallet, 'REFUND', 'refund', { amount: '40.00', reference: 'bet' });
      const again = await submit(wallet, 'REFUND', 'refund-2', { amount: '40.00', reference: 'bet' });
      const rollback = await submit(wallet, 'ROLLBACK', 'rb', { amount: '40.00', reference: 'bet' });
      expect(refund.status).toBe('PROCESSED');
      expect([again.failureCode, rollback.failureCode]).toEqual(['ALREADY_REVERSED', 'ALREADY_REVERSED']);
      expect(balanceOf(wallet)).toBe('100.00');
    });

    it('ROLLBACK moves opposite to its reference: BET back, WIN out, REFUND re-debited', async () => {
      const wallet = await open('100.00');
      await submit(wallet, 'BET', 'bet', { amount: '10.00' });
      await submit(wallet, 'ROLLBACK', 'rb-bet', { amount: '10.00', reference: 'bet' });
      expect(balanceOf(wallet)).toBe('100.00');

      await submit(wallet, 'BET', 'bet-2', { amount: '10.00', roundId: 'round-2' });
      await submit(wallet, 'WIN', 'win-2', { amount: '50.00', reference: 'bet-2', roundId: 'round-2' });
      await submit(wallet, 'ROLLBACK', 'rb-win', { amount: '50.00', reference: 'win-2', roundId: 'round-2' });
      expect(balanceOf(wallet)).toBe('90.00');

      await submit(wallet, 'BET', 'bet-3', { amount: '20.00', roundId: 'round-3' });
      await submit(wallet, 'REFUND', 'refund-3', { amount: '20.00', reference: 'bet-3', roundId: 'round-3' });
      const rbRefund = await submit(wallet, 'ROLLBACK', 'rb-refund', { amount: '20.00', reference: 'refund-3', roundId: 'round-3' });
      expect(rbRefund.status).toBe('PROCESSED');
      expect(balanceOf(wallet)).toBe('70.00');
      const refundAgain = await submit(wallet, 'REFUND', 'refund-3b', { amount: '20.00', reference: 'bet-3', roundId: 'round-3' });
      expect(refundAgain.failureCode).toBe('ALREADY_REVERSED');
    });

    it.each([
      ['an amount that differs from the reference', 'REFUND', { amount: '9.99', reference: 'bet' }, 'AMOUNT_MISMATCH'],
      ['a REFUND of a WIN', 'REFUND', { amount: '5.00', reference: 'win' }, 'INVALID_REFERENCE_KIND'],
      ['a reference from another round', 'REFUND', { amount: '10.00', reference: 'bet', roundId: 'round-9' }, 'REFERENCE_MISMATCH'],
      ['a ROLLBACK of a WIN that would overdraw', 'ROLLBACK', { amount: '5.00', reference: 'win' }, 'REVERSAL_INSUFFICIENT_FUNDS'],
      ['a BET without funds', 'BET', { amount: '0.01' }, 'INSUFFICIENT_FUNDS'],
      ['another currency', 'BET', { amount: '1.00', currency: 'USD' }, 'CURRENCY_MISMATCH'],
      ['another player', 'BET', { amount: '1.00', playerId: aPlayerId(2) }, 'WALLET_PLAYER_MISMATCH'],
    ] as const)('rejects %s, auditable and without touching the balance', async (_name, kind, options, code) => {
      const wallet = await open('10.00');
      await submit(wallet, 'BET', 'bet', { amount: '10.00' });
      await submit(wallet, 'WIN', 'win', { amount: '5.00', reference: 'bet' });
      await submit(wallet, 'BET', 'drain', { amount: '5.00' });
      const ledgerBefore = app.db.ledger.count();

      const result = await submit(wallet, kind, 'tx', options);

      expect(result).toMatchObject({ status: 'REJECTED', failureCode: code, balance: { amount: '0.00', currency: 'BRL' } });
      expect(app.db.wagers.read(result.transactionId)?.status).toBe('REJECTED');
      expect(app.db.ledger.count()).toBe(ledgerBefore);
      expect(balanceOf(wallet)).toBe('0.00');
      expect(app.db.outbox.all().at(-1)?.eventType).toBe('WagerTransactionRejected');
    });

    it.each([
      ['another player', { playerId: aPlayerId(2) }, 'WALLET_PLAYER_MISMATCH'],
      ['another currency', { currency: 'USD' }, 'CURRENCY_MISMATCH'],
    ] as const)('rejects a dependent of %s at once instead of parking it as pending', async (_name, options, code) => {
      const wallet = await open('100.00');
      const result = await submit(wallet, 'ROLLBACK', 'rb', { amount: '10.00', reference: 'missing', ...options });
      expect(result).toMatchObject({ status: 'REJECTED', failureCode: code });
    });

    it('a reference that was rejected rejects the dependent at once with REFERENCE_NOT_PROCESSED', async () => {
      const wallet = await open('5.00');
      const bet = await submit(wallet, 'BET', 'bet', { amount: '10.00' });
      const refund = await submit(wallet, 'REFUND', 'refund', { amount: '10.00', reference: 'bet' });
      expect(bet.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(refund).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED' });
      expect(balanceOf(wallet)).toBe('5.00');
    });
  });

  describe('input validation (400, nothing persisted)', () => {
    it.each([
      ['OPENING', (input: ReturnType<typeof aSubmission>) => ({ ...input, payload: { ...input.payload, kind: 'OPENING' } }), 'kind'],
      ['an unknown kind', (input: ReturnType<typeof aSubmission>) => ({ ...input, payload: { ...input.payload, kind: 'JACKPOT' } }), 'kind'],
      ['a blank idempotency key', (input: ReturnType<typeof aSubmission>) => ({ ...input, idempotencyKey: ' ' }), 'idempotencyKey'],
      ['a blank wallet id', (input: ReturnType<typeof aSubmission>) => ({ ...input, payload: { ...input.payload, walletId: '' } }), 'walletId'],
      ['a wallet id that is not a UUID', (input: ReturnType<typeof aSubmission>) => ({ ...input, payload: { ...input.payload, walletId: 'wallet-x' } }), 'walletId'],
      ['a player id that is not a UUID', (input: ReturnType<typeof aSubmission>) => ({ ...input, payload: { ...input.payload, playerId: 'player-x' } }), 'playerId'],
      ['a NUL byte in a text field', (input: ReturnType<typeof aSubmission>) => ({ ...input, payload: { ...input.payload, roundId: 'round\u00001' } }), 'roundId'],
      [
        'an amount with one decimal',
        (input: ReturnType<typeof aSubmission>) => ({ ...input, payload: { ...input.payload, money: { amount: '25.5', currency: 'BRL' } } }),
        'money.amount',
      ],
      [
        'a JSON number amount',
        (input: ReturnType<typeof aSubmission>) => ({
          ...input,
          payload: { ...input.payload, money: { amount: 25 as unknown as string, currency: 'BRL' } },
        }),
        'money.amount',
      ],
      [
        'a missing money',
        (input: ReturnType<typeof aSubmission>) => ({ ...input, payload: { ...input.payload, money: undefined as never } }),
        'money',
      ],
      [
        'a REFUND without reference',
        (input: ReturnType<typeof aSubmission>) => ({ ...input, payload: { ...input.payload, kind: 'REFUND' } }),
        'referenceExternalTransactionId',
      ],
      [
        'a BET with zero amount',
        (input: ReturnType<typeof aSubmission>) => ({ ...input, payload: { ...input.payload, money: { amount: '0.00', currency: 'BRL' } } }),
        'money.amount',
      ],
      [
        'a lowercase currency',
        (input: ReturnType<typeof aSubmission>) => ({ ...input, payload: { ...input.payload, money: { amount: '1.00', currency: 'brl' } } }),
        'money.currency',
      ],
      [
        'an external id with surrounding whitespace',
        (input: ReturnType<typeof aSubmission>) => ({ ...input, payload: { ...input.payload, externalTransactionId: ' tx' } }),
        'externalTransactionId',
      ],
      [
        'an idempotency key with a trailing space',
        (input: ReturnType<typeof aSubmission>) => ({ ...input, idempotencyKey: 'key ' }),
        'idempotencyKey',
      ],
      [
        'an SQS source without messageId',
        (input: ReturnType<typeof aSubmission>) => ({ ...input, source: { channel: 'SQS', consumerName: 'c', messageId: '' } as const }),
        'messageId',
      ],
    ])('rejects %s', async (_name, mutate, field) => {
      const wallet = await open();
      const error = await app.process.execute(mutate(aSubmission(wallet, 'BET', 'tx'))).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(InvalidRequestError);
      expect((error as InvalidRequestError).field).toBe(field);
      expect(wagerCount()).toBe(0);
      expect(app.db.inbox.size()).toBe(0);
    });
  });

  it.each([
    ['BET 0.00', 'BET', { amount: '0.00' }, 'money.amount', 'AMOUNT_MUST_BE_POSITIVE'],
    ['REFUND without reference', 'REFUND', {}, 'referenceExternalTransactionId', 'REFERENCE_REQUIRED'],
    ['an amount with one decimal', 'BET', { amount: '1.5' }, 'money.amount', 'INVALID_MONEY_AMOUNT'],
    ['a lowercase currency', 'BET', { currency: 'brl' }, 'money.currency', 'INVALID_CURRENCY'],
    ['OPENING', 'OPENING', {}, 'kind', 'KIND_NOT_SUBMITTABLE'],
    ['an unknown kind', 'JACKPOT', {}, 'kind', 'INVALID_KIND'],
    ['a round id with surrounding whitespace', 'BET', { roundId: ' round-1' }, 'roundId', 'SURROUNDING_WHITESPACE'],
  ] as const)('names the rule a request broke: %s', async (_name, kind, options, field, rule) => {
    const wallet = await open();
    const error = await app.process.execute(aSubmission(wallet, kind, 'tx', options)).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect(error).toMatchObject({ field, rule });
  });

  describe('PROVIDER_IDENTITY_MISMATCH', () => {
    it('refuses a provider acting for another one and writes nothing under the victim namespace', async () => {
      const wallet = await open();
      await expect(submit(wallet, 'BET', 'tx', { actor: 'provider-evil' })).rejects.toBeInstanceOf(
        ProviderIdentityMismatchError,
      );
      await expect(
        submit(wallet, 'BET', 'tx', { actor: 'provider-evil', source: SQS('msg-evil') }),
      ).rejects.toMatchObject({ failureCode: 'PROVIDER_IDENTITY_MISMATCH' });
      expect(wagerCount()).toBe(0);
      expect(app.db.inbox.size()).toBe(0);

      const legit = await submit(wallet, 'BET', 'tx');
      expect(legit).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    });
  });

  describe('WALLET_NOT_FOUND', () => {
    it('is raised without persisting anything, and the inbox stays unmarked for a later redelivery', async () => {
      const ghost = { id: '00000000-0000-7000-8000-00000000dead', playerId: aPlayerId(1), balance: { amount: '0.00', currency: 'BRL' }, version: 1 };
      await expect(app.process.execute(aSubmission(ghost, 'BET', 'tx'))).rejects.toBeInstanceOf(WalletNotFoundError);
      const sqs = aSubmission(ghost, 'BET', 'tx', { source: SQS('msg-1') });
      await expect(app.process.execute(sqs)).rejects.toMatchObject({ failureCode: 'WALLET_NOT_FOUND' });
      await expect(app.process.execute(sqs)).rejects.toBeInstanceOf(WalletNotFoundError);
      expect(app.db.wagers.all()).toEqual([]);
      expect(app.db.inbox.size()).toBe(0);
      expect(app.db.outbox.all()).toEqual([]);
    });
  });

  describe('idempotency', () => {
    it('normalizes the case of the wallet and player ids, so an upper-case redelivery is a replay, not a conflict', async () => {
      const playerId = 'abcdef00-0000-4000-8000-00000000beef';
      const wallet = await open('100.00', playerId);
      const first = await app.process.execute(aSubmission(wallet, 'BET', 'tx', { source: SQS('msg-1') }));
      const shouting = aSubmission({ id: wallet.id.toUpperCase(), playerId: playerId.toUpperCase() }, 'BET', 'tx', {
        source: SQS('msg-2'),
      });

      const replay = await app.process.execute(shouting);

      expect(first.status).toBe('PROCESSED');
      expect(replay).toEqual({ ...first, idempotentReplay: true });
      expect(balanceOf(wallet)).toBe('90.00');
    });

    it('answers an identical request with the original result and idempotentReplay, without new effects', async () => {
      const wallet = await open();
      const first = await submit(wallet, 'BET', 'tx', { amount: '25.00' });
      const effects = [app.db.ledger.count(), app.db.outbox.all().length, wagerCount()];
      const replay = await submit(wallet, 'BET', 'tx', { amount: '25.00' });
      expect(replay).toEqual({ ...first, idempotentReplay: true });
      expect([app.db.ledger.count(), app.db.outbox.all().length, wagerCount()]).toEqual(effects);
    });

    it('answers a committed replay from the lock-free pre-check, without waiting for the wallet lock', async () => {
      const wallet = await open();
      await submit(wallet, 'BET', 'tx', { amount: '25.00' });
      let walletLocks = 0;
      app.uow.before('wallets.lockById', () => void (walletLocks += 1));
      expect((await submit(wallet, 'BET', 'tx', { amount: '25.00' })).idempotentReplay).toBe(true);
      expect(walletLocks).toBe(0);
      app.uow.clearFaults();
    });

    it('a twin committed between the two lock-free lookups is a replay, not DUPLICATE_EXTERNAL_TRANSACTION', async () => {
      const wallet = await open();
      let winner: Awaited<ReturnType<typeof submit>> | undefined;
      app.uow.before(
        'wagers.findByExternalId',
        async () => {
          winner = await submit(wallet, 'BET', 'tx', { amount: '25.00' });
        },
        1,
      );
      const replay = await submit(wallet, 'BET', 'tx', { amount: '25.00' });
      expect(replay).toEqual({ ...winner!, idempotentReplay: true });
      expect(balanceOf(wallet)).toBe('975.00');
    });

    it('same key with another payload is IDEMPOTENCY_CONFLICT (409), never a replay', async () => {
      const wallet = await open();
      const first = await submit(wallet, 'BET', 'tx', { amount: '25.00' });
      const error = await submit(wallet, 'BET', 'tx', { amount: '25.01' }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(IdempotencyConflictError);
      expect(error).toMatchObject({ failureCode: 'IDEMPOTENCY_CONFLICT', existingTransactionId: first.transactionId });
      expect(balanceOf(wallet)).toBe('975.00');
    });

    it('same external id under another key is DUPLICATE_EXTERNAL_TRANSACTION (409)', async () => {
      const wallet = await open();
      await submit(wallet, 'BET', 'tx', { amount: '25.00' });
      await expect(submit(wallet, 'BET', 'tx', { amount: '25.00', key: 'other-key' })).rejects.toMatchObject({
        failureCode: 'DUPLICATE_EXTERNAL_TRANSACTION',
      });
      expect(wagerCount()).toBe(1);
    });

    it('scopes keys by provider', async () => {
      const wallet = await open();
      const a = await submit(wallet, 'BET', 'tx', { key: 'shared-key' });
      const b = await submit(wallet, 'BET', 'tx', { key: 'shared-key', providerId: 'provider-b' });
      expect(a.transactionId).not.toBe(b.transactionId);
      expect(balanceOf(wallet)).toBe('980.00');
    });

    it('historical replay: the first BET still answers 975.00 after the balance moved to 950.00', async () => {
      const wallet = await open();
      const first = await submit(wallet, 'BET', 'bet-1', { amount: '25.00' });
      const second = await submit(wallet, 'BET', 'bet-2', { amount: '25.00' });
      const replay = await submit(wallet, 'BET', 'bet-1', { amount: '25.00' });
      expect(second.balance?.amount).toBe('950.00');
      expect(replay).toEqual({ ...first, idempotentReplay: true });
      expect(replay.balance?.amount).toBe('975.00');
    });

    it('replays a REJECTED decision with its failure code and observed balance', async () => {
      const wallet = await open('10.00');
      const rejected = await submit(wallet, 'BET', 'bet', { amount: '50.00' });
      await submit(wallet, 'WIN', 'win', { amount: '100.00' });
      const replay = await submit(wallet, 'BET', 'bet', { amount: '50.00' });
      expect(replay).toEqual({ ...rejected, idempotentReplay: true });
      expect(replay).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
      expect(balanceOf(wallet)).toBe('110.00');
    });

    it('the same request over HTTP and SQS is processed once', async () => {
      const wallet = await open();
      const http = await submit(wallet, 'BET', 'tx', { amount: '25.00' });
      const sqs = await submit(wallet, 'BET', 'tx', { amount: '25.00', source: SQS('msg-1') });
      expect(sqs).toEqual({ ...http, idempotentReplay: true, channel: 'SQS' });
      expect(balanceOf(wallet)).toBe('975.00');
    });
  });

  describe('concurrency (real interleaving over the fake row locks)', () => {
    it('50 identical BETs in parallel: 1 PROCESSED + 49 replays with the same transaction and balance', async () => {
      const wallet = await open();
      const results = await Promise.all(
        Array.from({ length: 50 }, () => submit(wallet, 'BET', 'tx', { amount: '25.00' })),
      );
      expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
      expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
      expect(new Set(results.map((result) => `${result.status}/${result.balance?.amount}`))).toEqual(
        new Set(['PROCESSED/975.00']),
      );
      expect(balanceOf(wallet)).toBe('975.00');
      expect((await app.db.ledger.listAll(wallet.id)).filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
    });

    it('README §8: two 80.00 BETs over 100.00 → one PROCESSED, one REJECTED, 20.00 left, one debit', async () => {
      const wallet = await open('100.00');
      const results = await Promise.all([
        submit(wallet, 'BET', 'bet-a', { amount: '80.00' }),
        submit(wallet, 'BET', 'bet-b', { amount: '80.00' }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
      expect(results.find((result) => result.status === 'REJECTED')?.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(balanceOf(wallet)).toBe('20.00');
      expect((await app.db.ledger.listAll(wallet.id)).filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);

      const retries = await Promise.all([
        submit(wallet, 'BET', 'bet-a', { amount: '80.00' }),
        submit(wallet, 'BET', 'bet-b', { amount: '80.00' }),
      ]);
      expect(retries.every((result) => result.idempotentReplay)).toBe(true);
      expect(balanceOf(wallet)).toBe('20.00');
    });

    it('different wallets progress in parallel without interfering', async () => {
      const wallets = await Promise.all(Array.from({ length: 5 }, (_, i) => open('100.00', aPlayerId(i))));
      await Promise.all(
        wallets.flatMap((wallet) =>
          Array.from({ length: 10 }, (_, i) => submit(wallet, 'BET', `${wallet.id}-bet-${i}`, { amount: '10.00' })),
        ),
      );
      expect(wallets.map(balanceOf)).toEqual(wallets.map(() => '0.00'));
    });

    it('the same key on two wallets in parallel: one PROCESSED, the other IDEMPOTENCY_CONFLICT', async () => {
      const [w1, w2] = await Promise.all([open('100.00', aPlayerId(1)), open('100.00', aPlayerId(2))]);
      const results = await Promise.allSettled([
        submit(w1!, 'BET', 'tx', { amount: '10.00' }),
        submit(w2!, 'BET', 'tx', { amount: '10.00' }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejection = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(rejection.reason).toBeInstanceOf(IdempotencyConflictError);
      expect(wagerCount()).toBe(1);
    });

    describe('when a concurrent commit wins the race on the unique constraint', () => {
      const commitTwin = async (wallet: WalletView, options: SubmissionOptions, sameWallet: WalletView) => {
        const input = aSubmission(wallet, 'BET', 'tx', options);
        const twin = WagerTransaction.create({
          id: 'twin',
          providerId: input.payload.providerId,
          idempotencyKey: input.idempotencyKey,
          externalTransactionId: input.payload.externalTransactionId,
          playerId: input.payload.playerId,
          walletId: sameWallet.id,
          roundId: input.payload.roundId,
          gameId: input.payload.gameId,
          kind: WagerKind.BET,
          money: Money.from(input.payload.money),
          payloadHash: app.hasher.hash({
            providerId: input.payload.providerId,
            externalTransactionId: input.payload.externalTransactionId,
            playerId: input.payload.playerId,
            walletId: sameWallet.id,
            roundId: input.payload.roundId,
            gameId: input.payload.gameId,
            kind: WagerKind.BET,
            money: input.payload.money,
            referenceExternalTransactionId: null,
          }),
          createdAt: app.clock.now(),
        });
        twin.markProcessed(Money.from({ amount: '90.00', currency: 'BRL' }), app.clock.now());
        app.uow.before(
          'wagers.insert',
          async () => {
            app.db.wagers.write(twin);
          },
          1,
        );
        return input;
      };

      it('rolls back, re-reads in a new unit of work and replays when the hash matches', async () => {
        const wallet = await open('100.00');
        const input = await commitTwin(wallet, { amount: '10.00' }, wallet);
        const rollbacksBefore = app.uow.rollbacks;
        const result = await app.process.execute(input);
        expect(result).toMatchObject({ transactionId: 'twin', idempotentReplay: true, balance: { amount: '90.00' } });
        expect(app.uow.rollbacks).toBe(rollbacksBefore + 1);
        expect(balanceOf(wallet)).toBe('100.00');
      });

      it('rolls back, re-reads and answers 409 when the winner has another payload', async () => {
        const [w1, w2] = await Promise.all([open('100.00', aPlayerId(1)), open('100.00', aPlayerId(2))]);
        const input = await commitTwin(w1!, { amount: '10.00' }, w2!);
        await expect(app.process.execute(input)).rejects.toMatchObject({
          failureCode: 'IDEMPOTENCY_CONFLICT',
          existingTransactionId: 'twin',
        });
        expect(balanceOf(w1!)).toBe('100.00');
        expect(app.db.outbox.all().filter((message) => message.eventType !== 'WalletBalanceChanged')).toEqual([]);
      });

      it('gives up after one re-read when the violation persists', async () => {
        const wallet = await open('100.00');
        app.uow.before('wagers.insert', () => {
          throw new UniqueConstraintViolationError('UNIQUE(reference_transaction_id)');
        });
        await expect(submit(wallet, 'BET', 'tx')).rejects.toBeInstanceOf(UniqueConstraintViolationError);
        app.uow.clearFaults();
        expect(balanceOf(wallet)).toBe('100.00');
        expect(app.uow.rollbacks).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe('atomicity', () => {
    it.each(['wagers.insert', 'ledger.append', 'wallets.update', 'outbox.add', 'inbox.markProcessed'] as const)(
      'a failure at %s leaves no trace of the transaction anywhere',
      async (point) => {
        const wallet = await open('100.00');
        const outboxBefore = app.db.outbox.all().length;
        const ledgerBefore = app.db.ledger.count();
        app.uow.failNext(point);
        const input = aSubmission(wallet, 'BET', 'tx', { amount: '30.00', source: SQS('msg-1') });

        await expect(app.process.execute(input)).rejects.toBeInstanceOf(InjectedFaultError);

        expect(wagerCount()).toBe(0);
        expect(app.db.ledger.count()).toBe(ledgerBefore);
        expect(app.db.outbox.all()).toHaveLength(outboxBefore);
        expect(app.db.inbox.size()).toBe(0);
        expect(app.db.wallets.read(wallet.id)?.version).toBe(1);
        expect(balanceOf(wallet)).toBe('100.00');

        const redelivered = await app.process.execute(input);
        expect(redelivered).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
        expect(balanceOf(wallet)).toBe('70.00');
      },
    );
  });

  it('rejects a WIN past the Money maximum with BALANCE_LIMIT_EXCEEDED, auditable and without touching the balance', async () => {
    const wallet = await open('999999999999999999.99');
    const win = await submit(wallet, 'WIN', 'win', { amount: '0.01' });
    expect(win).toMatchObject({
      status: 'REJECTED',
      failureCode: 'BALANCE_LIMIT_EXCEEDED',
      balance: { amount: '999999999999999999.99', currency: 'BRL' },
    });
    expect(balanceOf(wallet)).toBe('999999999999999999.99');
    expect(app.db.wallets.read(wallet.id)?.version).toBe(1);
    expect(app.db.outbox.all().at(-1)?.payload.data).toMatchObject({
      transactionId: win.transactionId,
      failureCode: 'BALANCE_LIMIT_EXCEEDED',
    });
  });

  it('carries the HTTP correlation id on every event of the decision, without a causation id', async () => {
    const wallet = await open();
    const before = app.db.outbox.all().length;
    await submit(wallet, 'BET', 'tx', { correlationId: 'req-1' });
    const events = app.db.outbox.all().slice(before);
    expect(events.map((message) => message.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    for (const message of events) {
      expect(message.payload.correlationId).toBe('req-1');
      expect(message.payload.causationId).toBeUndefined();
    }
  });

  describe('SQS inbox', () => {
    it('marks the message processed in the same unit of work and carries it as causation', async () => {
      const wallet = await open();
      const result = await submit(wallet, 'BET', 'tx', { source: SQS('msg-1') });
      expect(result.channel).toBe('SQS');
      expect((await app.db.inbox.find('wager-consumer', 'msg-1'))?.isProcessed()).toBe(true);
      const processed = app.db.outbox.all().find((message) => message.eventType === 'WagerTransactionProcessed');
      expect(processed?.payload).toMatchObject({ correlationId: 'msg-1', causationId: 'msg-1' });
    });

    it('a redelivery of a processed message is a replay and adds nothing', async () => {
      const wallet = await open();
      const first = await submit(wallet, 'BET', 'tx', { source: SQS('msg-1') });
      const again = await submit(wallet, 'BET', 'tx', { source: SQS('msg-1') });
      expect(again).toEqual({ ...first, idempotentReplay: true });
      expect(app.db.inbox.size()).toBe(1);
      expect(wagerCount()).toBe(1);
    });

    it('the same messageId with another payload is a permanent error and persists nothing', async () => {
      const wallet = await open();
      await submit(wallet, 'BET', 'tx', { source: SQS('msg-1') });
      await expect(submit(wallet, 'BET', 'tx-other', { source: SQS('msg-1') })).rejects.toMatchObject({
        name: 'InboxPayloadMismatchError',
        messageId: 'msg-1',
      });
      expect(wagerCount()).toBe(1);
      expect(balanceOf(wallet)).toBe('990.00');
    });

    it('a new messageId for an already committed decision is a replay that still records the message', async () => {
      const wallet = await open();
      const first = await submit(wallet, 'BET', 'tx', { source: SQS('msg-1') });
      const other = await submit(wallet, 'BET', 'tx', { source: SQS('msg-2') });
      expect(other).toEqual({ ...first, idempotentReplay: true });
      expect(wagerCount()).toBe(1);
      expect((await app.db.inbox.find('wager-consumer', 'msg-2'))?.isProcessed()).toBe(true);
    });

    it('a messageId reused for another request is a payload mismatch even when that request was committed over HTTP', async () => {
      const wallet = await open();
      await submit(wallet, 'BET', 'tx-a', { source: SQS('msg-1') });
      await submit(wallet, 'BET', 'tx-b');
      await expect(submit(wallet, 'BET', 'tx-b', { source: SQS('msg-1') })).rejects.toMatchObject({
        name: 'InboxPayloadMismatchError',
        messageId: 'msg-1',
      });
      expect(balanceOf(wallet)).toBe('980.00');
    });

    it('a messageId reused with the same key and another amount is a payload mismatch, not a 409', async () => {
      const wallet = await open();
      await submit(wallet, 'BET', 'tx', { amount: '10.00', source: SQS('msg-1') });
      const error = await submit(wallet, 'BET', 'tx', { amount: '11.00', source: SQS('msg-1') }).catch(
        (reason: unknown) => reason,
      );
      expect(error).toMatchObject({ name: 'InboxPayloadMismatchError', messageId: 'msg-1' });
      expect(error).not.toBeInstanceOf(IdempotencyConflictError);
      expect(wagerCount()).toBe(1);
    });

    it('a new messageId whose request is committed by someone else while waiting for the lock is replayed and marked processed', async () => {
      const wallet = await open();
      let winner: Awaited<ReturnType<typeof submit>> | undefined;
      app.uow.before(
        'wallets.lockById',
        async () => {
          winner = await submit(wallet, 'BET', 'tx', { amount: '25.00' });
        },
        1,
      );
      const result = await submit(wallet, 'BET', 'tx', { amount: '25.00', source: SQS('msg-1') });
      expect(winner?.idempotentReplay).toBe(false);
      expect(result).toEqual({ ...winner!, idempotentReplay: true, channel: 'SQS' });
      expect((await app.db.inbox.find('wager-consumer', 'msg-1'))?.isProcessed()).toBe(true);
      expect(wagerCount()).toBe(1);
      expect(balanceOf(wallet)).toBe('975.00');
    });
  });

  describe('out-of-order references', () => {
    it('a ROLLBACK before its BET waits as PENDING_REFERENCE; the retry settles it once the BET lands', async () => {
      const wallet = await open('100.00');
      const rollback = await submit(wallet, 'ROLLBACK', 'rb', { amount: '30.00', reference: 'bet' });
      expect(rollback).toMatchObject({
        status: 'PENDING_REFERENCE',
        failureCode: null,
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      const pending = app.db.wagers.read(rollback.transactionId)!;
      expect(pending.attempts).toBe(1);
      expect(pending.nextAttemptAt).toEqual(new Date(app.clock.now().getTime() + 1_000));
      expect(eventTypes().at(-1)).toBe('WagerTransactionPendingReference');

      expect(await submit(wallet, 'ROLLBACK', 'rb', { amount: '30.00', reference: 'bet' })).toMatchObject({
        status: 'PENDING_REFERENCE',
        idempotentReplay: true,
      });

      await submit(wallet, 'BET', 'bet', { amount: '30.00' });
      expect(balanceOf(wallet)).toBe('70.00');

      app.clock.advance(1_000);
      expect(await app.retry.execute()).toMatchObject({ claimed: 1, processed: 1 });
      expect(balanceOf(wallet)).toBe('100.00');

      const replay = await submit(wallet, 'ROLLBACK', 'rb', { amount: '30.00', reference: 'bet' });
      expect(replay).toMatchObject({
        transactionId: rollback.transactionId,
        status: 'PROCESSED',
        idempotentReplay: true,
        balance: { amount: '100.00' },
      });
    });

    it('a WIN with a missing reference also waits', async () => {
      const wallet = await open('100.00');
      expect((await submit(wallet, 'WIN', 'win', { amount: '5.00', reference: 'bet' })).status).toBe('PENDING_REFERENCE');
      expect(balanceOf(wallet)).toBe('100.00');
    });
  });
});

