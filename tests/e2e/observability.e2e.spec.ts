import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { createObservability, type Observability } from '../../src/infrastructure/observability/observability';
import { assertEveryFakeWalletConsistent } from '../support/assertions/assert-fake-wallet-consistency';
import { LogCapture } from '../support/fakes/log-capture';
import { client } from './support/http-client';
import { type InMemoryHttpApp, startInMemoryHttpApp } from './support/in-memory-http-app';

const INITIAL_BALANCE = '987.65';
const BET_AMOUNT = '123.45';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('observability over HTTP', () => {
  let http: InMemoryHttpApp;
  let call: ReturnType<typeof client>;
  let capture: LogCapture;
  let observability: Observability;
  let sequence = 0;

  const scrape = async () => {
    const response = await fetch(`${http.baseUrl}/metrics`);
    return { response, text: await response.text() };
  };

  const series = (text: string, name: string, labels: string): number | undefined => {
    const line = text.split('\n').find((candidate) => candidate.startsWith(`${name}{${labels}}`));
    return line === undefined ? undefined : Number.parseInt(line.split(' ').at(-1) ?? '', 10);
  };

  const openWallet = async () => {
    const reply = await call('POST', '/wallets', {
      body: { playerId: Bun.randomUUIDv7(), initialBalance: { amount: INITIAL_BALANCE, currency: 'BRL' } },
    });
    expect(reply.status).toBe(201);
    return reply.body.data as { id: string; playerId: string };
  };

  const bet = (wallet: { id: string; playerId: string }, amount: string) => {
    sequence += 1;
    return {
      providerId: 'provider-a',
      externalTransactionId: `obs-tx-${sequence}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    };
  };

  const submit = (body: ReturnType<typeof bet>, headers: Record<string, string> = {}) =>
    call('POST', '/wagering/transactions', {
      body,
      headers: { 'Idempotency-Key': `provider-a:${body.externalTransactionId}`, ...headers },
    });

  beforeAll(async () => {
    capture = new LogCapture();
    observability = createObservability({ level: 'info', destination: capture });
    http = await startInMemoryHttpApp({ observability });
    call = client(http.baseUrl);
  });

  afterEach(() => assertEveryFakeWalletConsistent(http.fake.db));
  afterAll(() => http?.close());

  it('serves the metrics raw and without credentials', async () => {
    const { response, text } = await scrape();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(text).toContain('# TYPE wager_transactions_total counter');
    expect(text).toContain('# TYPE lock_wait_seconds histogram');
    expect(text).not.toContain('"code"');
  });

  it('counts a BET, its replay and a rejection', async () => {
    const wallet = await openWallet();
    const first = bet(wallet, BET_AMOUNT);

    expect((await submit(first)).status).toBe(200);
    const replay = await submit(first);
    expect(replay.status).toBe(200);
    expect(replay.body.data.idempotentReplay).toBe(true);
    expect((await submit(bet(wallet, '5000.00'))).status).toBe(422);

    const { text } = await scrape();
    expect(series(text, 'wager_transactions_total', 'status="PROCESSED",kind="BET"')).toBe(1);
    expect(series(text, 'wager_transactions_total', 'status="REJECTED",kind="BET"')).toBe(1);
    expect(series(text, 'idempotent_duplicates_total', 'channel="http"')).toBe(1);
    expect(series(text, 'processing_duration_seconds_count', 'operation="process_wager_transaction",outcome="processed"')).toBe(1);
    expect(series(text, 'processing_duration_seconds_count', 'operation="process_wager_transaction",outcome="replay"')).toBe(1);
    expect(series(text, 'processing_duration_seconds_count', 'operation="process_wager_transaction",outcome="rejected"')).toBe(1);
    // O replay HTTP é respondido pelo pre-check sem lock: só as duas decisões dão lock na wallet.
    const lockWaits = /^lock_wait_seconds_count (\d+)$/m.exec(text)?.[1];
    expect(Number.parseInt(lockWaits ?? '0', 10)).toBe(2);
  });

  it('echoes the X-Correlation-Id it got, logs it and hands it to the use case', async () => {
    const wallet = await openWallet();
    capture.clear();
    const body = bet(wallet, BET_AMOUNT);

    const reply = await submit(body, { 'X-Correlation-Id': 'corr-e2e-1' });

    expect(reply.status).toBe(200);
    expect(reply.headers.get('x-correlation-id')).toBe('corr-e2e-1');
    expect(capture.find('process_wager_transaction completed')).toMatchObject({
      correlationId: 'corr-e2e-1',
      providerId: 'provider-a',
      walletId: wallet.id,
      transactionId: reply.body.data.transactionId,
      status: 'PROCESSED',
    });
    expect(capture.find('http request')).toMatchObject({
      correlationId: 'corr-e2e-1',
      providerId: 'provider-a',
      method: 'POST',
      path: '/wagering/transactions',
      statusCode: 200,
    });
    const events = http.fake.db.outbox.all().filter((message) => message.aggregateId === wallet.id);
    expect(events.map((message) => message.payload.correlationId)).toContain('corr-e2e-1');
  });

  it.each([
    ['no header', {}],
    ['an invalid header', { 'X-Correlation-Id': 'has spaces and \u00e7' }],
    ['a header too long', { 'X-Correlation-Id': 'x'.repeat(129) }],
  ])('makes a correlation id up when it gets %s', async (_case, headers) => {
    capture.clear();

    const reply = await call('GET', `/wallets/${Bun.randomUUIDv7()}`, { headers: headers as Record<string, string> });

    const correlationId = reply.headers.get('x-correlation-id') ?? '';
    expect(correlationId).toMatch(UUID);
    expect(capture.find('http request')?.correlationId).toBe(correlationId);
  });

  it('answers with the correlation id even when the body is refused before any route', async () => {
    const reply = await call('POST', '/wagering/transactions', {
      rawBody: '{not json',
      headers: { 'X-Correlation-Id': 'corr-malformed' },
    });

    expect(reply.status).toBe(400);
    expect(reply.headers.get('x-correlation-id')).toBe('corr-malformed');
  });

  it('never writes a monetary value or a payload to the log', async () => {
    capture.clear();
    const wallet = await openWallet();
    await submit(bet(wallet, BET_AMOUNT));
    await submit(bet(wallet, '5000.00'));
    await call('GET', `/wallets/${wallet.id}`);
    await call('GET', `/wallets/${wallet.id}/ledger`);
    await call('POST', `/wallets/${wallet.id}/reconciliation`);

    const log = capture.raw.join('');
    expect(capture.raw.length).toBeGreaterThan(5);
    for (const value of [INITIAL_BALANCE, BET_AMOUNT, '864.20', '5000.00', '98765', '12345']) {
      expect(log).not.toContain(value);
    }
    expect(log).not.toMatch(/"(amount|balance|money|initialBalance)":\s*[{"0-9]/);
  });
});
