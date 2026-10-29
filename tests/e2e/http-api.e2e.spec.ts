import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { FailureCode } from '../../src/business/shared/error/failure-code';
import { assertEveryFakeWalletConsistent } from '../support/assertions/assert-fake-wallet-consistency';
import { client, expectEnvelope, type Reply } from './support/http-client';
import { databaseDown, type InMemoryHttpApp, startInMemoryHttpApp } from './support/in-memory-http-app';

const NIL_UUID = '00000000-0000-7000-8000-000000000000';

describe('HTTP API over the in-memory persistence', () => {
  let http: InMemoryHttpApp;
  let call: ReturnType<typeof client>;
  let now: number;
  let sequence = 0;

  const unique = (prefix: string) => `${prefix}-${++sequence}`;
  const expectReply = (reply: Reply, status: number, details: string[] = []) => expectEnvelope(reply, status, details, now);

  const openWallet = async (amount = '100.00', currency = 'BRL') => {
    const reply = await call('POST', '/wallets', {
      body: { playerId: Bun.randomUUIDv7(), initialBalance: { amount, currency } },
    });
    return expectReply(reply, 201).data as { id: string; playerId: string };
  };

  const submission = (
    wallet: { id: string; playerId: string },
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    providerId: 'provider-a',
    externalTransactionId: unique('tx'),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  });

  const submit = (body: Record<string, unknown>, options: { key?: string | null; provider?: string } = {}) => {
    const key = options.key === undefined ? `${body.providerId}:${body.externalTransactionId}` : options.key;
    return call('POST', '/wagering/transactions', {
      body,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      headers: key === null ? {} : { 'Idempotency-Key': key },
    });
  };

  beforeAll(async () => {
    http = await startInMemoryHttpApp();
    call = client(http.baseUrl);
    now = http.fake.clock.now().getTime();
  });

  beforeEach(() => {
    http.uow.failure = undefined;
  });

  afterEach(async () => {
    http.uow.failure = undefined;
    await assertEveryFakeWalletConsistent(http.fake.db);
  });

  afterAll(() => http?.close());

  describe('wallets', () => {
    it('creates a wallet (201) and conflicts on the same player and currency (409)', async () => {
      const playerId = Bun.randomUUIDv7();
      const body = { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } };
      const created = expectReply(await call('POST', '/wallets', { body }), 201);
      expect(created.data).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
      const conflict = expectReply(await call('POST', '/wallets', { body }), 409, ['WALLET_ALREADY_EXISTS']);
      expect(conflict.detailsMessage[0]).toMatchObject({ message: 'WALLET.ERROR.WALLET_ALREADY_EXISTS', field: 'playerId' });
    });

    it('reads a wallet (200), 404 for an unknown one and 400 for a non UUID id', async () => {
      const wallet = await openWallet('50.00');
      expect(expectReply(await call('GET', `/wallets/${wallet.id}`), 200).data.balance).toEqual({ amount: '50.00', currency: 'BRL' });
      expectReply(await call('GET', `/wallets/${NIL_UUID}`), 404, ['WALLET_NOT_FOUND']);
      const invalid = expectReply(await call('GET', '/wallets/not-a-uuid'), 400, ['INVALID_UUID']);
      expect(invalid.detailsMessage[0]?.field).toBe('walletId');
    });

    it('pages the ledger with a stable cursor and rejects a tampered one', async () => {
      const wallet = await openWallet('100.00');
      for (let index = 0; index < 3; index++) expectReply(await submit(submission(wallet)), 200);

      const first = expectReply(await call('GET', `/wallets/${wallet.id}/ledger?limit=2`), 200).data;
      expect(first.entries.map((entry: { entryType: string }) => entry.entryType)).toEqual(['OPENING', 'BET']);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = expectReply(
        await call('GET', `/wallets/${wallet.id}/ledger?limit=2&cursor=${first.nextCursor}`),
        200,
      ).data;
      expect(second.entries.map((entry: { walletVersion: number }) => entry.walletVersion)).toEqual([3, 4]);
      expect(second.nextCursor).toBeNull();

      expectReply(await submit(submission(wallet)), 200);
      const appended = expectReply(
        await call('GET', `/wallets/${wallet.id}/ledger?limit=2&cursor=${first.nextCursor}`),
        200,
      ).data;
      expect(appended.entries.map((entry: { walletVersion: number }) => entry.walletVersion)).toEqual([3, 4]);
      const tail = expectReply(await call('GET', `/wallets/${wallet.id}/ledger?cursor=${appended.nextCursor}`), 200).data;
      expect(tail).toMatchObject({ entries: [{ walletVersion: 5 }], nextCursor: null });

      for (const cursor of [btoa('seq:-1'), btoa('offset:2'), `${first.nextCursor}!`, 'x'.repeat(600)]) {
        const tampered = expectReply(
          await call('GET', `/wallets/${wallet.id}/ledger?cursor=${encodeURIComponent(cursor)}`),
          400,
          ['INVALID_CURSOR'],
        );
        expect(tampered.detailsMessage[0]?.field).toBe('cursor');
      }
      expectReply(await call('GET', `/wallets/${wallet.id}/ledger?limit=0`), 400, ['INVALID_LIMIT']);
      expectReply(await call('GET', `/wallets/${wallet.id}/ledger?limit=201`), 400, ['INVALID_LIMIT']);
      expectReply(await call('GET', `/wallets/${NIL_UUID}/ledger`), 404, ['WALLET_NOT_FOUND']);
    });

    it('reconciles a wallet and reports it consistent', async () => {
      const wallet = await openWallet('100.00');
      expectReply(await submit(submission(wallet, { money: { amount: '25.00', currency: 'BRL' } })), 200);
      const report = expectReply(await call('POST', `/wallets/${wallet.id}/reconciliation`), 200).data;
      expect(report).toEqual({
        walletId: wallet.id,
        storedBalance: { amount: '75.00', currency: 'BRL' },
        calculatedBalance: { amount: '75.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 2,
      });
      expectReply(await call('POST', `/wallets/${NIL_UUID}/reconciliation`), 404, ['WALLET_NOT_FOUND']);
    });
  });

  describe('wager transactions', () => {
    it('applies a BET (200) and replays it with idempotentReplay', async () => {
      const wallet = await openWallet('100.00');
      const body = submission(wallet, { money: { amount: '25.00', currency: 'BRL' } });
      const first = expectReply(await submit(body), 200).data;
      expect(first).toEqual({
        transactionId: expect.any(String),
        status: 'PROCESSED',
        balance: { amount: '75.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      const replay = expectReply(await submit(body), 200).data;
      expect(replay).toEqual({ ...first, idempotentReplay: true });
    });

    it('answers 409 when the same key comes with another payload', async () => {
      const wallet = await openWallet('100.00');
      const body = submission(wallet);
      expectReply(await submit(body), 200);
      const conflict = expectReply(
        await submit({ ...body, money: { amount: '11.00', currency: 'BRL' } }, { key: `provider-a:${body.externalTransactionId}` }),
        409,
        ['IDEMPOTENCY_CONFLICT'],
      );
      expect(conflict.data.existingTransactionId).toEqual(expect.any(String));
    });

    it('answers 422 with data for a rejection, and the same 422 on its replay', async () => {
      const wallet = await openWallet('5.00');
      const body = submission(wallet, { money: { amount: '25.00', currency: 'BRL' } });
      const rejected = expectReply(await submit(body), 422, ['INSUFFICIENT_FUNDS']);
      expect(rejected.data).toMatchObject({ status: 'REJECTED', balance: { amount: '5.00', currency: 'BRL' }, idempotentReplay: false });
      expect(rejected.detailsMessage[0]?.message).toBe('WAGERING.ERROR.INSUFFICIENT_FUNDS');
      const replay = expectReply(await submit(body), 422, ['INSUFFICIENT_FUNDS']);
      expect(replay.data).toEqual({ ...rejected.data, idempotentReplay: true });
    });

    it('answers 202 for a reversal that waits for its reference', async () => {
      const wallet = await openWallet('100.00');
      const pending = expectReply(
        await submit(submission(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: unique('missing-bet') })),
        202,
        ['REFERENCE_PENDING'],
      );
      expect(pending.data).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00', currency: 'BRL' } });
      expect(pending.detailsMessage[0]).toMatchObject({ type: 'warning', message: 'WAGERING.WARNING.REFERENCE_PENDING' });
    });

    it('answers 403 when the provider acts for another one, and 404 for an unknown wallet', async () => {
      const wallet = await openWallet('100.00');
      expectReply(await submit(submission(wallet), { provider: 'provider-b' }), 403, ['PROVIDER_IDENTITY_MISMATCH']);
      expectReply(await submit(submission({ id: NIL_UUID, playerId: wallet.playerId })), 404, ['WALLET_NOT_FOUND']);
    });

    it.each([
      ['an amount with three decimals', { money: { amount: '10.005', currency: 'BRL' } }, 'INVALID_MONEY_AMOUNT', 'money.amount'],
      ['a numeric amount', { money: { amount: 10, currency: 'BRL' } }, 'MUST_BE_STRING', 'money.amount'],
      ['a lowercase currency', { money: { amount: '10.00', currency: 'brl' } }, 'INVALID_CURRENCY', 'money.currency'],
      ['a walletId that is not a UUID', { walletId: 'wallet-1' }, 'INVALID_UUID', 'walletId'],
      ['kind OPENING', { kind: 'OPENING' }, 'KIND_NOT_SUBMITTABLE', 'kind'],
      ['an unknown kind', { kind: 'BONUS' }, 'INVALID_KIND', 'kind'],
      ['a blank roundId', { roundId: '' }, 'BLANK', 'roundId'],
      ['an unknown field', { extra: true }, 'UNKNOWN_FIELD', 'extra'],
    ])('answers 400 per field for %s', async (_case, overrides, code, field) => {
      const wallet = await openWallet('100.00');
      const reply = expectReply(await submit(submission(wallet, overrides)), 400, [code]);
      expect(reply.detailsMessage[0]?.field).toBe(field);
    });

    it.each([
      ['a BET of 0.00', { money: { amount: '0.00', currency: 'BRL' } }, 'AMOUNT_MUST_BE_POSITIVE', 'money.amount'],
      ['a REFUND without reference', { kind: 'REFUND' }, 'REFERENCE_REQUIRED', 'referenceExternalTransactionId'],
      ['a BET with a reference', { referenceExternalTransactionId: 'bet-0' }, 'REFERENCE_NOT_ALLOWED', 'referenceExternalTransactionId'],
      ['an external id with surrounding spaces', { externalTransactionId: ' tx-padded ' }, 'SURROUNDING_WHITESPACE', 'externalTransactionId'],
    ])('answers 400 on the exact field for an entity rule: %s', async (_case, overrides, code, field) => {
      const wallet = await openWallet('100.00');
      const reply = expectReply(await submit(submission(wallet, overrides)), 400, [code]);
      expect(reply.detailsMessage[0]).toMatchObject({ field, message: `VALIDATION.ERROR.${code}` });
    });

    it('requires the Idempotency-Key header', async () => {
      const wallet = await openWallet('100.00');
      const reply = expectReply(await submit(submission(wallet), { key: null }), 400, ['IDEMPOTENCY_KEY_REQUIRED']);
      expect(reply.detailsMessage[0]?.field).toBe('Idempotency-Key');
    });

    it('reports every invalid field at once, money format included', async () => {
      const reply = await submit({ kind: 'OPENING', money: { amount: '1', currency: 'BRL' } }, { key: 'k' });
      expect(reply.status).toBe(400);
      expect(reply.body.detailsMessage.map((item) => item.field)).toEqual([
        'providerId',
        'externalTransactionId',
        'playerId',
        'walletId',
        'roundId',
        'gameId',
        'kind',
        'money.amount',
      ]);
    });

    it('checks amount and currency independently and joins them with the other fields', async () => {
      const wallet = await openWallet('100.00');
      const reply = expectReply(
        await submit(submission(wallet, { roundId: '', money: { amount: '1', currency: 'brl' } })),
        400,
        ['BLANK', 'INVALID_MONEY_AMOUNT', 'INVALID_CURRENCY'],
      );
      expect(reply.detailsMessage.map((item) => item.field)).toEqual(['roundId', 'money.amount', 'money.currency']);
    });

    it('reports a missing Idempotency-Key together with an invalid body', async () => {
      const wallet = await openWallet('100.00');
      const reply = expectReply(await submit(submission(wallet, { walletId: 'nope' }), { key: null }), 400, [
        'INVALID_UUID',
        'IDEMPOTENCY_KEY_REQUIRED',
      ]);
      expect(reply.detailsMessage.map((item) => item.field)).toEqual(['walletId', 'Idempotency-Key']);
    });

    it('checks the wallet balance money independently too', async () => {
      const reply = expectReply(
        await call('POST', '/wallets', { body: { playerId: Bun.randomUUIDv7(), initialBalance: { amount: '1.5', currency: 'usd' } } }),
        400,
        ['INVALID_MONEY_AMOUNT', 'INVALID_CURRENCY'],
      );
      expect(reply.detailsMessage.map((item) => item.field)).toEqual(['initialBalance.amount', 'initialBalance.currency']);
    });

    it.each([
      ['__proto__ at the top', '{"__proto__":{"polluted":true},"playerId":"PLAYER","initialBalance":{"amount":"1.00","currency":"BRL"}}', '__proto__'],
      ['__proto__ nested', '{"playerId":"PLAYER","initialBalance":{"amount":"1.00","currency":"BRL","__proto__":{"polluted":true}}}', 'initialBalance.__proto__'],
      ['constructor', '{"constructor":{"prototype":{"polluted":true}},"playerId":"PLAYER","initialBalance":{"amount":"1.00","currency":"BRL"}}', 'constructor'],
      ['prototype', '{"playerId":"PLAYER","initialBalance":{"amount":"1.00","currency":"BRL"},"prototype":{}}', 'prototype'],
    ])('rejects a body carrying %s and creates nothing', async (_case, raw, field) => {
      const playerId = Bun.randomUUIDv7();
      const reply = expectReply(
        await call('POST', '/wallets', { rawBody: raw.replace('PLAYER', playerId), headers: { 'Content-Type': 'application/json' } }),
        400,
        ['FORBIDDEN_KEY'],
      );
      expect(reply.detailsMessage[0]?.field).toBe(field);
      expect(http.fake.db.wallets.all().some((wallet) => wallet.playerId === playerId)).toBe(false);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('rejects prototype keys on the wager route as well, next to a missing key', async () => {
      const reply = expectReply(
        await call('POST', '/wagering/transactions', {
          rawBody: '{"__proto__":{"polluted":true}}',
          headers: { 'Content-Type': 'application/json' },
        }),
        400,
        ['FORBIDDEN_KEY', 'IDEMPOTENCY_KEY_REQUIRED'],
      );
      expect(reply.detailsMessage[0]?.field).toBe('__proto__');
    });

    it('answers 413 for a body over the limit', async () => {
      const reply = await call('POST', '/wallets', { body: { playerId: 'x'.repeat(200_000) } });
      expectReply(reply, 413, ['PAYLOAD_TOO_LARGE']);
    });

    it.each(['text/plain', 'application/xml', 'application/x-www-form-urlencoded'])(
      'answers 415 for a %s body',
      async (contentType) => {
        const reply = await call('POST', '/wagering/transactions', {
          rawBody: 'kind=BET',
          headers: { 'Content-Type': contentType, 'Idempotency-Key': 'k' },
        });
        expectReply(reply, 415, ['UNSUPPORTED_MEDIA_TYPE']);
      },
    );

    it('accepts JSON with a charset and a POST without any body', async () => {
      const wallet = await openWallet('100.00');
      expectReply(
        await call('POST', '/wagering/transactions', {
          rawBody: JSON.stringify(submission(wallet, { externalTransactionId: 'charset-tx' })),
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Idempotency-Key': 'provider-a:charset-tx' },
        }),
        200,
      );
      expectReply(await call('POST', `/wallets/${wallet.id}/reconciliation`), 200);
    });

    it('answers 400 on the path for a malformed URI', async () => {
      const reply = expectReply(await call('GET', '/wallets/%E0%A4%A'), 400, ['MALFORMED_PATH']);
      expect(reply.detailsMessage[0]?.field).toBe('path');
    });

    it('rejects a malformed JSON body', async () => {
      expectReply(
        await call('POST', '/wagering/transactions', { rawBody: '{oops', headers: { 'Idempotency-Key': 'k' } }),
        400,
        ['MALFORMED_BODY'],
      );
    });

    it('reads a transaction by id and by provider id; another provider gets 404 by id and 403 by its own path', async () => {
      const wallet = await openWallet('100.00');
      const body = submission(wallet);
      const { transactionId } = expectReply(await submit(body), 200).data;

      const byId = expectReply(await call('GET', `/wagering/transactions/${transactionId}`), 200).data;
      expect(byId).toMatchObject({ transactionId, providerId: 'provider-a', status: 'PROCESSED', kind: 'BET' });
      const byExternal = expectReply(
        await call('GET', `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`),
        200,
      ).data;
      expect(byExternal.transactionId).toBe(transactionId);

      const foreign = expectReply(await call('GET', `/wagering/transactions/${transactionId}`, { provider: 'provider-b' }), 404, [
        'TRANSACTION_NOT_FOUND',
      ]);
      const missing = expectReply(await call('GET', `/wagering/transactions/${NIL_UUID}`, { provider: 'provider-b' }), 404, [
        'TRANSACTION_NOT_FOUND',
      ]);
      expect({ ...foreign, timestamp: 0 }).toEqual({ ...missing, timestamp: 0 });
      expectReply(
        await call('GET', `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`, { provider: 'provider-b' }),
        403,
        ['PROVIDER_IDENTITY_MISMATCH'],
      );
      expectReply(await call('GET', `/wagering/transactions/${NIL_UUID}`), 404, ['TRANSACTION_NOT_FOUND']);
      expectReply(await call('GET', '/providers/provider-a/wagering/transactions/nope'), 404, ['TRANSACTION_NOT_FOUND']);
      expectReply(await call('GET', '/wagering/transactions/abc'), 400, ['INVALID_UUID']);
    });
  });

  describe('authentication', () => {
    const businessRoutes: Array<[string, string]> = [
      ['POST', '/wallets'],
      ['GET', `/wallets/${NIL_UUID}`],
      ['GET', `/wallets/${NIL_UUID}/ledger`],
      ['POST', `/wallets/${NIL_UUID}/reconciliation`],
      ['POST', '/wagering/transactions'],
      ['GET', `/wagering/transactions/${NIL_UUID}`],
      ['GET', '/providers/provider-a/wagering/transactions/tx-1'],
    ];

    it.each(businessRoutes)('answers 401 on %s %s without or with an invalid credential', async (method, path) => {
      expectReply(await call(method, path, { provider: null }), 401, ['UNAUTHORIZED']);
      expectReply(await call(method, path, { provider: null, headers: { Authorization: 'Bearer not-a-dev-token' } }), 401, [
        'UNAUTHORIZED',
      ]);
    });

    it('accepts the dev X-Provider-Id header', async () => {
      expectReply(await call('GET', `/wallets/${NIL_UUID}`, { provider: null, headers: { 'X-Provider-Id': 'provider-a' } }), 404, [
        'WALLET_NOT_FOUND',
      ]);
    });

    it('keeps health, the catalog and the docs open, and health raw', async () => {
      const live = await call('GET', '/health/live', { provider: null });
      expect({ status: live.status, body: live.body }).toEqual({ status: 200, body: { status: 'ok' } as never });
      expect((await call('GET', '/docs-json', { provider: null })).status).toBe(200);
      expect((await fetch(`${http.baseUrl}/docs`)).status).toBe(200);
      const catalog = expectReply(await call('GET', '/i18n', { provider: null }), 200).data as Array<{ code: string }>;
      for (const code of Object.values(FailureCode)) expect(catalog.map((entry) => entry.code)).toContain(code);
    });
  });

  describe('readiness', () => {
    const raw = async (base: string) => {
      const response = await fetch(`${base}/health/ready`);
      return { status: response.status, body: (await response.json()) as unknown };
    };

    it('answers 200, raw and without credentials, over the in-memory fakes (nothing to check)', async () => {
      expect(await raw(http.baseUrl)).toEqual({ status: 200, body: { status: 'ready', checks: {} } });
    });

    it('answers 200 while every check is up and 503, still raw, when one is down or hangs', async () => {
      let postgres: 'up' | 'down' | 'hang' = 'up';
      const probed = await startInMemoryHttpApp({
        readinessChecks: [
          {
            name: 'postgres',
            check: () =>
              postgres === 'up'
                ? Promise.resolve()
                : postgres === 'down'
                  ? Promise.reject(new Error('connection refused'))
                  : new Promise(() => undefined),
          },
          { name: 'sqs', check: () => Promise.resolve() },
        ],
      });
      try {
        expect(await raw(probed.baseUrl)).toEqual({ status: 200, body: { status: 'ready', checks: { postgres: 'up', sqs: 'up' } } });
        postgres = 'down';
        const down = { status: 503, body: { status: 'unavailable', checks: { postgres: 'down', sqs: 'up' } } };
        expect(await raw(probed.baseUrl)).toEqual(down);
        postgres = 'hang';
        expect(await raw(probed.baseUrl)).toEqual(down);
        expect((await call('GET', '/health/live', { provider: null })).status).toBe(200);
      } finally {
        await probed.close();
      }
    });
  });

  describe('infrastructure failures', () => {
    it('answers 503 with Retry-After while the database is down, on every unit of work endpoint', async () => {
      const wallet = await openWallet('100.00');
      http.uow.failure = databaseDown();
      const replies = [
        await submit(submission(wallet)),
        await call('POST', '/wallets', { body: { playerId: Bun.randomUUIDv7(), initialBalance: { amount: '1.00', currency: 'BRL' } } }),
        await call('POST', `/wallets/${wallet.id}/reconciliation`),
      ];
      for (const reply of replies) {
        expectReply(reply, 503, ['INFRA_UNAVAILABLE']);
        expect(reply.headers.get('Retry-After')).toBe('3');
      }
    });

    it('answers 500 without leaking the internal message or stack', async () => {
      const wallet = await openWallet('100.00');
      http.uow.failure = new Error('secret connection string postgres://admin:hunter2@db');
      const reply = await submit(submission(wallet));
      expect(expectReply(reply, 500, ['INTERNAL_ERROR']).data).toBeNull();
      expect(reply.text).not.toContain('hunter2');
      expect(reply.text).not.toContain('at ');
    });

    it('answers an unknown route with a 404 envelope', async () => {
      expectReply(await call('GET', '/nope'), 404, ['ROUTE_NOT_FOUND']);
    });
  });
});
