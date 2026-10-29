import { InboxMessage } from '../../../messaging/entity/inbox-message';
import { OutboxMessage } from '../../../messaging/entity/outbox-message';
import { DomainError } from '../../../shared/error/domain-error';
import { InvalidRequestError } from '../../../shared/error/invalid-request-error';
import { UniqueConstraintViolationError } from '../../../shared/error/unique-constraint-violation-error';
import type { ExponentialBackoff } from '../../../shared/policy/exponential-backoff';
import type { IClock } from '../../../shared/port/clock.port';
import type { IIdGenerator } from '../../../shared/port/id-generator.port';
import type { IUseCase } from '../../../shared/use-case';
import { Money } from '../../../shared/value-object/money';
import type { Wallet } from '../../../wallet/entity/wallet';
import type { WalletLedgerEntry } from '../../../wallet/entity/wallet-ledger-entry';
import { WalletNotFoundError } from '../../../shared/error/wallet-not-found-error';
import { IdempotencyCheck } from '../../domain-service/idempotency-check';
import { ReferenceResolver } from '../../domain-service/reference-resolver';
import { WagerSettlement } from '../../domain-service/wager-settlement';
import { type CreateWagerTransactionProps, WagerTransaction } from '../../entity/wager-transaction';
import { WagerKind } from '../../enum/wager-kind';
import { IdempotencyConflictError } from '../../error/idempotency-conflict-error';
import { ProviderIdentityMismatchError } from '../../error/provider-identity-mismatch-error';
import type { IPayloadHasher, WagerPayload } from '../../port/payload-hasher.port';
import type { IWageringUnitOfWork, TxRepositories } from '../../port/tx-repositories.port';
import type {
  DecidedStatus,
  ProcessWagerTransactionInput,
  ProcessWagerTransactionOutput,
  WagerSource,
} from './process-wager-transaction.dto';
import { WagerOutcomeEvents } from './wager-outcome-events';

const MAX_TEXT_LENGTH = 255;
const SUBMITTABLE_KINDS: ReadonlySet<string> = new Set([
  WagerKind.BET,
  WagerKind.WIN,
  WagerKind.LOSS,
  WagerKind.REFUND,
  WagerKind.ROLLBACK,
]);

interface ParsedRequest {
  readonly props: Omit<CreateWagerTransactionProps, 'createdAt'>;
  readonly source: WagerSource;
  readonly messageHash: string | null;
  readonly correlationId: string;
  readonly causationId?: string;
}

/** Surrounding whitespace is rejected, not trimmed: " tx-1" and "tx-1" would otherwise hash and store apart. */
const requireText = (field: string, value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT_LENGTH) {
    throw new InvalidRequestError(field, `must be a non-blank string of at most ${MAX_TEXT_LENGTH} characters`);
  }
  if (value.trim() !== value) throw new InvalidRequestError(field, 'must not start or end with whitespace');
  return value;
};

/**
 * Orchestrates one submission (HTTP or SQS) in a single unit of work:
 * validate → normalized hash → lock-free idempotency pre-check (HTTP) → inbox (SQS) → wallet lock →
 * IdempotencyCheck → ReferenceResolver → WagerSettlement → transaction, ledger, wallet, outbox and inbox.
 *
 * Not persisted, by design: invalid input (400), a provider acting for another one (no row is written under the
 * victim's (provider, key) namespace, so it cannot be squatted), an unknown wallet (404, the inbox is not marked
 * either, so a redelivery is processed once the wallet exists) and idempotency conflicts (409).
 * A unique violation means a concurrent commit won the race (e.g. the same key on another wallet, which the wallet
 * lock does not serialize): the unit is rolled back and the decision is re-read in a fresh one.
 *
 * The pre-check is HTTP only: on SQS the inbox comes first, so a messageId reused with another payload is always
 * an InboxPayloadMismatchError (DLQ) and never a replay or a 409, and a new messageId for a committed decision is
 * still recorded as processed. The wallet lock that path costs on a hot wallet is the price of that guarantee.
 */
export class ProcessWagerTransaction implements IUseCase<ProcessWagerTransactionInput, ProcessWagerTransactionOutput> {
  private readonly settlement = new WagerSettlement();
  private readonly outcomeEvents: WagerOutcomeEvents;

  constructor(
    private readonly unitOfWork: IWageringUnitOfWork,
    private readonly hasher: IPayloadHasher,
    private readonly clock: IClock,
    private readonly ids: IIdGenerator,
    private readonly backoff: ExponentialBackoff,
  ) {
    this.outcomeEvents = new WagerOutcomeEvents(ids);
  }

  async execute(input: ProcessWagerTransactionInput): Promise<ProcessWagerTransactionOutput> {
    const request = this.parse(input);

    if (request.source.channel === 'HTTP') {
      const replay = await this.unitOfWork.run((tx) => this.precheck(tx, request));
      if (replay !== null) return replay;
    }

    try {
      return await this.unitOfWork.run((tx) => this.decide(tx, request));
    } catch (error) {
      if (!(error instanceof UniqueConstraintViolationError)) throw error;
      return this.unitOfWork.run((tx) => this.decide(tx, request));
    }
  }

  private parse(input: ProcessWagerTransactionInput): ParsedRequest {
    const { payload, source } = input;
    const providerId = requireText('providerId', payload.providerId);
    const kind = requireText('kind', payload.kind);
    if (kind === WagerKind.OPENING) throw new InvalidRequestError('kind', 'OPENING is internal and cannot be submitted');
    if (!SUBMITTABLE_KINDS.has(kind)) throw new InvalidRequestError('kind', `must be one of ${[...SUBMITTABLE_KINDS].join(', ')}`);
    const reference = payload.referenceExternalTransactionId ?? undefined;
    const props: Omit<CreateWagerTransactionProps, 'createdAt' | 'payloadHash'> = {
      id: this.ids.generate(),
      providerId,
      idempotencyKey: requireText('idempotencyKey', input.idempotencyKey),
      externalTransactionId: requireText('externalTransactionId', payload.externalTransactionId),
      playerId: requireText('playerId', payload.playerId),
      walletId: requireText('walletId', payload.walletId),
      roundId: requireText('roundId', payload.roundId),
      gameId: requireText('gameId', payload.gameId),
      kind: kind as WagerKind,
      money: this.parseMoney(payload.money),
      ...(reference === undefined ? {} : { referenceExternalTransactionId: requireText('referenceExternalTransactionId', reference) }),
    };
    if (source.channel === 'SQS') {
      requireText('consumerName', source.consumerName);
      requireText('messageId', source.messageId);
    }
    if (input.actor.providerId !== providerId) throw new ProviderIdentityMismatchError(input.actor.providerId, providerId);

    const normalized: WagerPayload = {
      providerId,
      externalTransactionId: props.externalTransactionId,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money.toProps(),
      referenceExternalTransactionId: props.referenceExternalTransactionId ?? null,
    };
    const withHash = { ...props, payloadHash: this.hasher.hash(normalized) };
    try {
      WagerTransaction.create({ ...withHash, createdAt: this.clock.now() });
    } catch (error) {
      if (error instanceof DomainError) throw new InvalidRequestError('payload', error.message);
      throw error;
    }
    return {
      props: withHash,
      source,
      messageHash:
        source.channel === 'SQS' ? this.hasher.hashMessage({ ...normalized, idempotencyKey: props.idempotencyKey }) : null,
      correlationId: input.correlationId ?? (source.channel === 'SQS' ? source.messageId : props.id),
      ...(source.channel === 'SQS' ? { causationId: source.messageId } : {}),
    };
  }

  private parseMoney(money: unknown): Money {
    try {
      return Money.from(money as Parameters<typeof Money.from>[0]);
    } catch (error) {
      if (error instanceof DomainError || error instanceof TypeError) throw new InvalidRequestError('money', String(error));
      throw error;
    }
  }

  /** Lock-free fast path for replays on a hot wallet: only already-committed decisions are answered here. */
  private async precheck(tx: TxRepositories, request: ParsedRequest): Promise<ProcessWagerTransactionOutput | null> {
    const decision = await new IdempotencyCheck(tx.wagers).check(request.props);
    if (decision.type === 'New') return null;
    if (decision.type === 'Conflict') throw new IdempotencyConflictError(decision.code, decision.existing.id);
    return this.output(decision.existing, await tx.wallets.findById(decision.existing.walletId), request, true);
  }

  private async decide(tx: TxRepositories, request: ParsedRequest): Promise<ProcessWagerTransactionOutput> {
    const now = this.clock.now();
    const inbox = await this.receive(tx, request, now);
    if (inbox === 'processed') {
      const replay = await this.precheck(tx, request);
      if (replay !== null) return replay;
    }

    const wallet = await tx.wallets.lockById(request.props.walletId);
    if (wallet === null) throw new WalletNotFoundError(request.props.walletId);

    const decision = await new IdempotencyCheck(tx.wagers).check(request.props);
    if (decision.type === 'Conflict') throw new IdempotencyConflictError(decision.code, decision.existing.id);
    if (decision.type === 'Replay') {
      await this.markProcessed(tx, inbox, now);
      return this.output(decision.existing, wallet, request, true);
    }

    const transaction = WagerTransaction.create({ ...request.props, createdAt: now });
    const expectedVersion = wallet.version;
    const entry = await this.apply(tx, transaction, wallet, now);

    await tx.wagers.insert(transaction);
    if (entry !== null) {
      await tx.ledger.append(entry);
      await tx.wallets.update(wallet, expectedVersion);
    }
    const events = this.outcomeEvents.toEvents(
      { transaction, wallet, entry },
      { correlationId: request.correlationId, causationId: request.causationId, occurredAt: now },
    );
    await tx.outbox.add(events.map((event) => OutboxMessage.fromEvent(event)));
    await this.markProcessed(tx, inbox, now);
    return this.output(transaction, wallet, request, false);
  }

  /**
   * Records the message in the inbox. A redelivery (same hash) that was already processed is answered from the
   * stored decision; the same messageId with another payload is a permanent contract violation (DLQ).
   */
  private async receive(
    tx: TxRepositories,
    request: ParsedRequest,
    now: Date,
  ): Promise<InboxMessage | 'processed' | null> {
    if (request.source.channel !== 'SQS' || request.messageHash === null) return null;
    const message = InboxMessage.create({
      consumerName: request.source.consumerName,
      messageId: request.source.messageId,
      payloadHash: request.messageHash,
      receivedAt: now,
    });
    const result = await tx.inbox.insertIfAbsent(message);
    if (result.inserted) return message;
    result.existing.ensureSamePayload(request.messageHash);
    return result.existing.isProcessed() ? 'processed' : result.existing;
  }

  private async markProcessed(tx: TxRepositories, inbox: InboxMessage | 'processed' | null, now: Date): Promise<void> {
    if (inbox === null || inbox === 'processed') return;
    inbox.markProcessed(now);
    await tx.inbox.markProcessed(inbox);
  }

  /** Decides the new transaction against the locked wallet; returns the ledger entry when money moved. */
  private async apply(
    tx: TxRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    now: Date,
  ): Promise<WalletLedgerEntry | null> {
    if (!wallet.isOwnedBy(transaction.playerId) || wallet.currency !== transaction.money.currency) {
      this.settlement.settle({ transaction, wallet, reference: null, at: now });
      return null;
    }
    const resolution = await new ReferenceResolver(tx.wagers).resolve(transaction);
    switch (resolution.type) {
      case 'Missing':
      case 'StillPending':
        transaction.markPendingReference(new Date(now.getTime() + this.backoff.nextDelayMs(1)));
        return null;
      case 'Rejected':
        transaction.attachReference(resolution.reference);
        transaction.reject(resolution.code, wallet.balance, now);
        return null;
      case 'Resolved': {
        const outcome = this.settlement.settle({ transaction, wallet, reference: resolution.reference, at: now });
        return outcome.type === 'Processed' ? outcome.entry : null;
      }
    }
  }

  private output(
    transaction: WagerTransaction,
    wallet: Wallet | null,
    request: ParsedRequest,
    idempotentReplay: boolean,
  ): ProcessWagerTransactionOutput {
    const balance = transaction.observedBalance ?? wallet?.balance;
    return {
      transactionId: transaction.id,
      kind: transaction.kind,
      status: transaction.status as DecidedStatus,
      failureCode: transaction.failureCode ?? null,
      balance: balance?.toProps() ?? null,
      idempotentReplay,
      channel: request.source.channel,
    };
  }
}

