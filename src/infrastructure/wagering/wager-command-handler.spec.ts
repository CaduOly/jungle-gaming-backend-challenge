import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { assertEveryFakeWalletConsistent } from '../../../tests/support/assertions/assert-fake-wallet-consistency';
import { createFakeWageringApp, type FakeWageringApp, type WalletView } from '../../../tests/support/fakes/fake-wagering-app';
import { aPlayerId } from '../../../tests/support/fakes/sequential-id-generator';
import { UniqueConstraintViolationError } from '../../business/shared/error/unique-constraint-violation-error';
import { PermanentInfrastructureError } from '../error/permanent-infrastructure-error';
import { TransientInfrastructureError } from '../error/transient-infrastructure-error';
import { InvalidMessageError } from '../messaging/sqs/invalid-message-error';
import { type InboundMessage, MessageOutcome } from '../messaging/sqs/message-handler.port';
import { WAGER_COMMAND_CONSUMER, WagerCommandHandler } from './wager-command-handler';

const command = (wallet: Pick<WalletView, 'id' | 'playerId'>, overrides: Record<string, unknown> = {}, messageId = 'msg-1') => ({
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'tx-1',
    idempotencyKey: 'provider-a:tx-1',
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  },
});

const inbound = (body: unknown): InboundMessage => ({ body, rawBody: JSON.stringify(body), sqsMessageId: 'sqs-1', receiveCount: 1 });

const failing = (error: unknown) => new WagerCommandHandler({ execute: async () => Promise.reject(error) });

const rejectionOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('WagerCommandHandler', () => {
  let app: FakeWageringApp;
  let handler: WagerCommandHandler;
  let wallet: WalletView;

  beforeEach(async () => {
    app = createFakeWageringApp();
    handler = new WagerCommandHandler(app.process);
    wallet = await app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: { amount: '100.00', currency: 'BRL' } });
  });

  afterEach(async () => {
    await assertEveryFakeWalletConsistent(app.db);
  });

  const balance = () => app.db.wallets.read(wallet.id)?.balance.amount;

  it('runs ProcessWagerTransaction with the SQS source and data.idempotencyKey, then acks', async () => {
    expect(await handler.handle(inbound(command(wallet)))).toEqual(MessageOutcome.ack());
    expect(balance()).toBe('75.00');
    expect((await app.db.inbox.find(WAGER_COMMAND_CONSUMER, 'msg-1'))?.isProcessed()).toBe(true);
    const tx = app.db.wagers.all().find((transaction) => transaction.kind === 'BET');
    expect(tx?.idempotencyKey).toBe('provider-a:tx-1');
    const event = app.db.outbox.all().find((message) => message.eventType === 'WagerTransactionProcessed');
    expect(event?.payload).toMatchObject({ correlationId: 'msg-1', causationId: 'msg-1' });
  });

  it('acks a redelivery once, without a second effect', async () => {
    await handler.handle(inbound(command(wallet)));
    expect(await handler.handle(inbound(command(wallet)))).toEqual(MessageOutcome.ack());
    expect(balance()).toBe('75.00');
  });

  it('acks a business rejection: the decision is recorded and is the answer', async () => {
    expect(await handler.handle(inbound(command(wallet, { money: { amount: '500.00', currency: 'BRL' } })))).toEqual(
      MessageOutcome.ack(),
    );
    expect(app.db.wagers.all().find((transaction) => transaction.kind === 'BET')?.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  it('acks an unknown wallet without persisting anything', async () => {
    const ghost = { id: '00000000-0000-7000-a000-00000000dead', playerId: aPlayerId(1) };
    expect(await handler.handle(inbound(command(ghost)))).toEqual(MessageOutcome.ack());
    expect(app.db.inbox.size()).toBe(0);
    expect(app.db.wagers.all().filter((transaction) => transaction.kind === 'BET')).toEqual([]);
  });

  it('acks an idempotency conflict (the same key with another payload) and persists nothing new', async () => {
    await handler.handle(inbound(command(wallet)));
    const other = command(wallet, { externalTransactionId: 'tx-2' }, 'msg-2');
    expect(await handler.handle(inbound(other))).toEqual(MessageOutcome.ack());
    expect(balance()).toBe('75.00');
  });

  it('dead-letters the same messageId with another payload', async () => {
    await handler.handle(inbound(command(wallet)));
    const outcome = await handler.handle(inbound(command(wallet, { roundId: 'round-2' })));
    expect(outcome).toMatchObject({ kind: 'dead-letter', reason: 'inbox_payload_mismatch' });
  });

  it('dead-letters content the use case refuses as invalid_schema, naming the field', async () => {
    const outcome = await handler.handle(inbound(command(wallet, { playerId: 'player-x' })));
    expect(outcome).toEqual(MessageOutcome.deadLetter('invalid_schema', 'playerId must be a UUID'));
  });

  it.each([
    ['not an object', 'text'],
    ['another type', { ...command({ id: 'w', playerId: 'p' }), type: 'Something' }],
    ['a missing field', { ...command({ id: 'w', playerId: 'p' }), data: { providerId: 'provider-a' } }],
    ['an unknown field', command({ id: 'w', playerId: 'p' }, { referenceExternalTransactionID: 'typo' })],
    ['a number amount', command({ id: 'w', playerId: 'p' }, { money: { amount: 25, currency: 'BRL' } })],
    ['a bad occurredAt', { ...command({ id: 'w', playerId: 'p' }), occurredAt: 'yesterday' }],
    ['a blank messageId', { ...command({ id: 'w', playerId: 'p' }), messageId: ' ' }],
  ])('refuses %s as invalid_schema before touching the use case', async (_, body) => {
    const error = await rejectionOf(handler.handle(inbound(body)));
    expect(error).toBeInstanceOf(InvalidMessageError);
    expect((error as InvalidMessageError).reason).toBe('invalid_schema');
    expect(app.db.inbox.size()).toBe(0);
  });

  it('refuses OPENING as a contract violation', async () => {
    const error = await rejectionOf(handler.handle(inbound(command(wallet, { kind: 'OPENING' }))));
    expect(error).toBeInstanceOf(InvalidMessageError);
    expect((error as InvalidMessageError).reason).toBe('contract_violation');
  });

  it('retries a lost unique race and rethrows a transient error for the consumer to classify', async () => {
    expect(await failing(new UniqueConstraintViolationError('some_unique')).handle(inbound(command(wallet)))).toEqual(
      MessageOutcome.retry(),
    );
    const transient = new TransientInfrastructureError('lock timeout', '55P03', { cause: undefined });
    expect(await rejectionOf(failing(transient).handle(inbound(command(wallet))))).toBe(transient);
  });

  it('dead-letters a permanent infrastructure failure and raises the alert', async () => {
    const alerts: unknown[] = [];
    const permanent = new PermanentInfrastructureError('integrity guard', '23514', { cause: undefined });
    const outcome = await new WagerCommandHandler(
      { execute: async () => Promise.reject(permanent) },
      { onPermanentFailure: (error) => alerts.push(error) },
    ).handle(inbound(command(wallet)));
    expect(outcome).toMatchObject({ kind: 'dead-letter', reason: 'permanent_infrastructure' });
    expect(alerts).toEqual([permanent]);
  });
});
