import { describe, expect, it } from 'bun:test';
import { FailureCode } from '../../../business/shared/error/failure-code';
import { InvalidRequestError } from '../../../business/shared/error/invalid-request-error';
import type { IUseCase } from '../../../business/shared/use-case';
import type {
  ProcessWagerTransactionInput,
  ProcessWagerTransactionOutput,
} from '../../../business/wagering/use-case/process-wager-transaction/process-wager-transaction.dto';
import { InsufficientFundsError } from '../../../business/wallet/error/insufficient-funds-error';
import type { ReconcileWalletOutput } from '../../../business/wallet/use-case/reconcile-wallet/reconcile-wallet';
import { LogCapture } from '../../../../tests/support/fakes/log-capture';
import { PermanentInfrastructureError } from '../../error/permanent-infrastructure-error';
import { TransientInfrastructureError } from '../../error/transient-infrastructure-error';
import { createLogger } from '../logging/logger';
import { runWithLogContext } from '../logging/log-context';
import { metricValue } from '../metrics/metric-value';
import { WageringMetrics } from '../metrics/wagering-metrics';
import { observeUseCase } from './observe-use-case';
import { processWagerTransactionObservation, reconcileWalletObservation } from './use-case-observations';

const input = (overrides: Partial<ProcessWagerTransactionInput> = {}): ProcessWagerTransactionInput => ({
  actor: { providerId: 'provider-a' },
  idempotencyKey: 'provider-a:tx-1',
  correlationId: 'corr-1',
  source: { channel: 'SQS', consumerName: 'wager-commands', messageId: 'msg-1' },
  payload: {
    providerId: 'provider-a',
    externalTransactionId: 'tx-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '987.65', currency: 'BRL' },
  },
  ...overrides,
});

const output = (overrides: Partial<ProcessWagerTransactionOutput> = {}): ProcessWagerTransactionOutput => ({
  transactionId: 'transaction-1',
  kind: 'BET',
  status: 'PROCESSED',
  failureCode: null,
  balance: { amount: '12.34', currency: 'BRL' },
  idempotentReplay: false,
  channel: 'SQS',
  ...overrides,
});

const answering = <I, O>(result: O | Error): IUseCase<I, O> => ({
  execute: async () => {
    if (result instanceof Error) throw result;
    return result;
  },
});

const setup = () => {
  const capture = new LogCapture();
  const tools = { logger: createLogger({ level: 'debug', destination: capture }), metrics: new WageringMetrics() };
  return { capture, ...tools, tools };
};

const lockTimeout = () => new TransientInfrastructureError('lock timeout', '55P03', { cause: undefined });

describe('process_wager_transaction metrics', () => {
  it('counts a decision by status and kind, and not as a duplicate', async () => {
    const { tools, metrics } = setup();
    const useCase = observeUseCase(answering(output({ status: 'REJECTED', kind: 'WIN' })), tools, processWagerTransactionObservation);

    await useCase.execute(input());

    expect(await metricValue(metrics, 'wager_transactions_total', { status: 'REJECTED', kind: 'WIN' })).toBe(1);
    expect(await metricValue(metrics, 'idempotent_duplicates_total', { channel: 'sqs' })).toBe(0);
    expect(await metricValue(metrics, 'processing_duration_seconds', { operation: 'process_wager_transaction', outcome: 'rejected' })).toBe(1);
  });

  it('counts a replay as a duplicate of its channel, never as a new decision', async () => {
    const { tools, metrics } = setup();
    const useCase = observeUseCase(
      answering(output({ idempotentReplay: true, channel: 'HTTP' })),
      tools,
      processWagerTransactionObservation,
    );

    await useCase.execute(input({ source: { channel: 'HTTP' } }));

    expect(await metricValue(metrics, 'idempotent_duplicates_total', { channel: 'http' })).toBe(1);
    expect(await metricValue(metrics, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(0);
    expect(await metricValue(metrics, 'processing_duration_seconds', { outcome: 'replay' })).toBe(1);
  });

  it.each([
    [lockTimeout(), 'lock_timeout'],
    [new TransientInfrastructureError('deadlock', '40P01', { cause: undefined }), 'deadlock'],
    [new TransientInfrastructureError('down', '08006', { cause: undefined }), 'transient'],
    [new PermanentInfrastructureError('trigger', '23001', { cause: undefined }), 'permanent'],
    [new InvalidRequestError('kind', 'is unknown'), 'invalid_request'],
    [new InsufficientFundsError(FailureCode.INSUFFICIENT_FUNDS, 'wallet-1'), 'business_rule'],
    [new Error('boom'), 'unexpected'],
  ])('labels a thrown %p as %p and rethrows it untouched', async (error, outcome) => {
    const { tools, metrics } = setup();
    const useCase = observeUseCase(answering<ProcessWagerTransactionInput, ProcessWagerTransactionOutput>(error), tools, processWagerTransactionObservation);

    await expect(useCase.execute(input())).rejects.toBe(error);
    expect(await metricValue(metrics, 'processing_duration_seconds', { outcome })).toBe(1);
    expect(await metricValue(metrics, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(0);
  });

  it('returns the output even when a recorder throws', async () => {
    const { tools } = setup();
    const decided = output();
    const useCase = observeUseCase(answering(decided), tools, {
      ...processWagerTransactionObservation,
      record: () => {
        throw new Error('broken metric');
      },
    });

    expect(await useCase.execute(input())).toBe(decided);
  });
});

describe('reconcile_wallet metrics', () => {
  const report = (consistent: boolean): ReconcileWalletOutput => ({
    walletId: 'wallet-1',
    storedBalance: { amount: '10.00', currency: 'BRL' },
    calculatedBalance: { amount: consistent ? '10.00' : '9.00', currency: 'BRL' },
    difference: { amount: consistent ? '0.00' : '1.00', currency: 'BRL' },
    consistent,
    checkedEntries: 2,
    divergences: [],
  });

  it('counts only the divergent reconciliations', async () => {
    const { tools, metrics } = setup();
    await observeUseCase(answering(report(true)), tools, reconcileWalletObservation).execute({ walletId: 'wallet-1' });
    await observeUseCase(answering(report(false)), tools, reconcileWalletObservation).execute({ walletId: 'wallet-1' });

    expect(await metricValue(metrics, 'reconciliation_divergences_total')).toBe(1);
  });
});

describe('use case logging', () => {
  it('logs one completed line with the identifiers of the input, the decision and no money', async () => {
    const { tools, capture } = setup();
    const useCase = observeUseCase(answering(output()), tools, processWagerTransactionObservation);

    await useCase.execute(input());

    const line = capture.find('process_wager_transaction completed');
    expect(line).toMatchObject({
      level: 'info',
      correlationId: 'corr-1',
      providerId: 'provider-a',
      walletId: 'wallet-1',
      messageId: 'msg-1',
      transactionId: 'transaction-1',
      status: 'PROCESSED',
      kind: 'BET',
      idempotentReplay: false,
    });
    expect(capture.raw.join('\n')).not.toMatch(/987\.65|12\.34|"amount"|"balance"/);
  });

  it('keeps the context of the caller (the HTTP request) and adds its own', async () => {
    const { tools, capture } = setup();
    const useCase = observeUseCase(answering(output()), tools, processWagerTransactionObservation);

    await runWithLogContext({ correlationId: 'from-request', causationId: 'cause-1' }, () =>
      useCase.execute(input({ correlationId: undefined, source: { channel: 'HTTP' } })),
    );

    expect(capture.find('process_wager_transaction completed')).toMatchObject({
      correlationId: 'from-request',
      causationId: 'cause-1',
      providerId: 'provider-a',
    });
  });

  it('logs a domain answer at info with its code, never its message', async () => {
    const { tools, capture } = setup();
    const error = new InsufficientFundsError(FailureCode.INSUFFICIENT_FUNDS, 'wallet-1');
    const useCase = observeUseCase(answering<ProcessWagerTransactionInput, ProcessWagerTransactionOutput>(error), tools, processWagerTransactionObservation);

    await expect(useCase.execute(input())).rejects.toBe(error);

    const line = capture.find('process_wager_transaction failed');
    expect(line).toMatchObject({
      level: 'info',
      errorClass: 'business_rule',
      error: 'InsufficientFundsError',
      failureCode: FailureCode.INSUFFICIENT_FUNDS,
    });
    expect(line).not.toHaveProperty('errorMessage');
  });

  it.each([
    [lockTimeout(), 'warn'],
    [new PermanentInfrastructureError('trigger', '23001', { cause: undefined }), 'error'],
    [new Error('boom'), 'error'],
  ])('logs %p at %p', async (error, level) => {
    const { tools, capture } = setup();
    const useCase = observeUseCase(answering<ProcessWagerTransactionInput, ProcessWagerTransactionOutput>(error), tools, processWagerTransactionObservation);

    await expect(useCase.execute(input())).rejects.toBe(error);

    expect(capture.find('process_wager_transaction failed')).toMatchObject({ level, errorMessage: error.message });
  });
});
