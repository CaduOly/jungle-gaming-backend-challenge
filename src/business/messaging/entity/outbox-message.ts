import { deepFreeze } from '../event/deep-freeze';
import { InvalidOutboxRetryError } from '../error/invalid-outbox-retry.error';
import { OutboxMessageAlreadyPublishedError } from '../error/outbox-message-already-published.error';
import type { IntegrationEvent, IntegrationEventEnvelope } from '../event/integration-event';

export interface OutboxMessageState {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: IntegrationEventEnvelope;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly lockedUntil?: Date;
  readonly publishedAt?: Date;
}

const copy = (date: Date): Date => new Date(date.getTime());
const copyOptional = (date: Date | undefined): Date | undefined => date && copy(date);

/** The id is the eventId, so a republished row keeps the dedup key the consumers rely on. */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly eventType: string,
    readonly aggregateType: string,
    readonly aggregateId: string,
    readonly payload: IntegrationEventEnvelope,
    private readonly _occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _lockedUntil?: Date,
    private _publishedAt?: Date,
  ) {}

  static fromEvent(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      event.eventType,
      event.aggregateType,
      event.aggregateId,
      deepFreeze(payload),
      copy(event.occurredAt),
      0,
      copy(event.occurredAt),
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.eventType,
      state.aggregateType,
      state.aggregateId,
      deepFreeze(structuredClone(state.payload)),
      copy(state.occurredAt),
      state.attempts,
      copy(state.nextAttemptAt),
      copyOptional(state.lockedUntil),
      copyOptional(state.publishedAt),
    );
  }

  get occurredAt(): Date {
    return copy(this._occurredAt);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return copy(this._nextAttemptAt);
  }

  get lockedUntil(): Date | undefined {
    return copyOptional(this._lockedUntil);
  }

  get publishedAt(): Date | undefined {
    return copyOptional(this._publishedAt);
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    const leased = this._lockedUntil !== undefined && this._lockedUntil.getTime() > now.getTime();
    return this.isPending() && !leased && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(now: Date): void {
    this.ensurePending();
    this._publishedAt = copy(now);
    this._lockedUntil = undefined;
  }

  scheduleRetry(now: Date, delayMs: number): void {
    this.ensurePending();
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new InvalidOutboxRetryError(delayMs);
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
    this._lockedUntil = undefined;
  }

  toState(): OutboxMessageState {
    return {
      id: this.id,
      eventType: this.eventType,
      aggregateType: this.aggregateType,
      aggregateId: this.aggregateId,
      payload: structuredClone(this.payload),
      occurredAt: this.occurredAt,
      attempts: this._attempts,
      nextAttemptAt: this.nextAttemptAt,
      ...(this._lockedUntil === undefined ? {} : { lockedUntil: this.lockedUntil }),
      ...(this._publishedAt === undefined ? {} : { publishedAt: this.publishedAt }),
    };
  }

  private ensurePending(): void {
    if (!this.isPending()) throw new OutboxMessageAlreadyPublishedError(this.id);
  }
}
