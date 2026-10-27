import type { FailureCode } from '../../shared/error/failure-code';
import { InvalidTransactionStateError } from '../../shared/error/invalid-transaction-state-error';
import type { Money } from '../../shared/value-object/money';
import type { WalletLedgerEntry } from '../../wallet/entity/wallet-ledger-entry';
import { WagerKind } from '../enum/wager-kind';
import { WagerTransactionStatus } from '../enum/wager-transaction-status';
import { InvalidWagerTransactionError } from '../error/invalid-wager-transaction-error';

export type LedgerDirection = WalletLedgerEntry['direction'];

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  idempotencyKey: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: Money;
  referenceExternalTransactionId?: string;
  payloadHash: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  referenceTransactionId?: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  observedBalance?: Money;
  attempts: number;
  nextAttemptAt?: Date;
  processedAt?: Date;
}

const TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  PENDING: [
    WagerTransactionStatus.PROCESSED,
    WagerTransactionStatus.REJECTED,
    WagerTransactionStatus.PENDING_REFERENCE,
  ],
  PENDING_REFERENCE: [
    WagerTransactionStatus.PROCESSED,
    WagerTransactionStatus.REJECTED,
    WagerTransactionStatus.FAILED,
  ],
  PROCESSED: [],
  REJECTED: [],
  FAILED: [],
};

const REQUIRED_TEXT_FIELDS = [
  'id',
  'providerId',
  'idempotencyKey',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'payloadHash',
] as const;

/** Kinds whose reference is mandatory; WIN and LOSS may optionally reference the BET of the round. */
const REFERENCE_REQUIRED: ReadonlySet<WagerKind> = new Set([WagerKind.REFUND, WagerKind.ROLLBACK]);
const REFERENCE_FORBIDDEN: ReadonlySet<WagerKind> = new Set([WagerKind.OPENING, WagerKind.BET]);

const opposite = (direction: LedgerDirection): LedgerDirection => (direction === 'CREDIT' ? 'DEBIT' : 'CREDIT');

/**
 * Transitions (README §6.3 + plan):
 *   PENDING (in memory only)  -> PROCESSED | REJECTED | PENDING_REFERENCE
 *   PENDING_REFERENCE         -> PROCESSED | REJECTED | FAILED
 *   PROCESSED, REJECTED, FAILED are terminal.
 * `processedAt` is the moment a terminal status was reached; `attempts` counts failed
 * reference resolutions (the first one happens when entering PENDING_REFERENCE).
 */
export class WagerTransaction {
  private constructor(private state: WagerTransactionState) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.validate(props);
    return new WagerTransaction({
      ...props,
      createdAt: new Date(props.createdAt),
      status: WagerTransactionStatus.PENDING,
      attempts: 0,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({ ...state });
  }

  get id(): string {
    return this.state.id;
  }

  get providerId(): string {
    return this.state.providerId;
  }

  get idempotencyKey(): string {
    return this.state.idempotencyKey;
  }

  get externalTransactionId(): string {
    return this.state.externalTransactionId;
  }

  get playerId(): string {
    return this.state.playerId;
  }

  get walletId(): string {
    return this.state.walletId;
  }

  get roundId(): string {
    return this.state.roundId;
  }

  get gameId(): string {
    return this.state.gameId;
  }

  get kind(): WagerKind {
    return this.state.kind;
  }

  get money(): Money {
    return this.state.money;
  }

  get referenceExternalTransactionId(): string | undefined {
    return this.state.referenceExternalTransactionId;
  }

  get referenceTransactionId(): string | undefined {
    return this.state.referenceTransactionId;
  }

  get status(): WagerTransactionStatus {
    return this.state.status;
  }

  get failureCode(): FailureCode | undefined {
    return this.state.failureCode;
  }

  get observedBalance(): Money | undefined {
    return this.state.observedBalance;
  }

  get payloadHash(): string {
    return this.state.payloadHash;
  }

  get attempts(): number {
    return this.state.attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return WagerTransaction.copyDate(this.state.nextAttemptAt);
  }

  get processedAt(): Date | undefined {
    return WagerTransaction.copyDate(this.state.processedAt);
  }

  get createdAt(): Date {
    return new Date(this.state.createdAt);
  }

  get affectsBalance(): boolean {
    return this.state.kind !== WagerKind.LOSS;
  }

  get isOpening(): boolean {
    return this.state.kind === WagerKind.OPENING;
  }

  get requiresReference(): boolean {
    return REFERENCE_REQUIRED.has(this.state.kind);
  }

  get isReversal(): boolean {
    return this.requiresReference;
  }

  get hasReference(): boolean {
    return this.state.referenceExternalTransactionId !== undefined;
  }

  isTerminal(): boolean {
    return TRANSITIONS[this.state.status].length === 0;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.state.payloadHash === payloadHash;
  }

  /** ROLLBACK moves money opposite to its reference; every other balance-affecting kind has a fixed direction. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.state.kind) {
      case WagerKind.BET:
        return 'DEBIT';
      case WagerKind.OPENING:
      case WagerKind.WIN:
      case WagerKind.REFUND:
        return 'CREDIT';
      case WagerKind.ROLLBACK:
        if (reference === undefined || reference.kind === WagerKind.ROLLBACK || !reference.affectsBalance) {
          throw new InvalidWagerTransactionError(`ROLLBACK cannot reverse ${reference?.kind ?? 'a missing reference'}`);
        }
        return opposite(reference.ledgerDirectionFor());
      case WagerKind.LOSS:
        throw new InvalidWagerTransactionError('LOSS does not move the balance');
    }
  }

  attachReference(reference: WagerTransaction): void {
    this.assertNotTerminal();
    if (reference.externalTransactionId !== this.state.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(
        `reference ${reference.externalTransactionId} is not ${this.state.referenceExternalTransactionId ?? 'set'}`,
      );
    }
    this.state = { ...this.state, referenceTransactionId: reference.id };
  }

  markProcessed(observedBalance: Money, at: Date): void {
    this.transitionTo(WagerTransactionStatus.PROCESSED);
    this.state = { ...this.state, observedBalance, processedAt: new Date(at), nextAttemptAt: undefined };
  }

  reject(code: FailureCode, observedBalance: Money, at: Date): void {
    this.transitionTo(WagerTransactionStatus.REJECTED);
    this.state = {
      ...this.state,
      failureCode: code,
      observedBalance,
      processedAt: new Date(at),
      nextAttemptAt: undefined,
    };
  }

  markPendingReference(nextAttemptAt: Date): void {
    this.transitionTo(WagerTransactionStatus.PENDING_REFERENCE);
    this.state = { ...this.state, attempts: 1, nextAttemptAt: new Date(nextAttemptAt) };
  }

  scheduleNextAttempt(nextAttemptAt: Date): void {
    if (this.state.status !== WagerTransactionStatus.PENDING_REFERENCE) {
      throw new InvalidTransactionStateError(this.state.status, WagerTransactionStatus.PENDING_REFERENCE);
    }
    this.state = { ...this.state, attempts: this.state.attempts + 1, nextAttemptAt: new Date(nextAttemptAt) };
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.FAILED);
    this.state = { ...this.state, failureCode: code, processedAt: new Date(at), nextAttemptAt: undefined };
  }

  toState(): WagerTransactionState {
    return {
      ...this.state,
      createdAt: this.createdAt,
      nextAttemptAt: this.nextAttemptAt,
      processedAt: this.processedAt,
    };
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this.state.status].includes(next)) {
      throw new InvalidTransactionStateError(this.state.status, next);
    }
    this.state = { ...this.state, status: next };
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this.state.status, this.state.status);
  }

  private static copyDate(date: Date | undefined): Date | undefined {
    return date === undefined ? undefined : new Date(date);
  }

  private static validate(props: CreateWagerTransactionProps): void {
    for (const field of REQUIRED_TEXT_FIELDS) {
      if (props[field].trim() === '') throw new InvalidWagerTransactionError(`${field} is required`);
    }
    const { kind, money, referenceExternalTransactionId: reference } = props;
    if (!Object.values(WagerKind).includes(kind)) throw new InvalidWagerTransactionError(`unknown kind ${kind}`);
    if (kind !== WagerKind.LOSS && !money.isPositive()) {
      throw new InvalidWagerTransactionError(`${kind} amount must be greater than zero`);
    }
    if (reference !== undefined && reference.trim() === '') {
      throw new InvalidWagerTransactionError('referenceExternalTransactionId cannot be empty');
    }
    if (REFERENCE_REQUIRED.has(kind) && reference === undefined) {
      throw new InvalidWagerTransactionError(`${kind} requires referenceExternalTransactionId`);
    }
    if (REFERENCE_FORBIDDEN.has(kind) && reference !== undefined) {
      throw new InvalidWagerTransactionError(`${kind} cannot have a reference`);
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('a transaction cannot reference itself');
    }
  }
}
