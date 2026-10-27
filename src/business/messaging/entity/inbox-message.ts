import { InboxMessageAlreadyProcessedError } from '../error/inbox-message-already-processed.error';
import { InboxPayloadMismatchError } from '../error/inbox-payload-mismatch.error';
import { InvalidInboxMessageError } from '../error/invalid-inbox-message.error';

export interface CreateInboxMessageProps {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends CreateInboxMessageProps {
  readonly processedAt?: Date;
}

const copy = (date: Date): Date => new Date(date.getTime());

export class InboxMessage {
  private constructor(
    readonly consumerName: string,
    readonly messageId: string,
    readonly payloadHash: string,
    private readonly _receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateInboxMessageProps): InboxMessage {
    if (props.consumerName.trim() === '') throw new InvalidInboxMessageError('consumerName');
    if (props.messageId.trim() === '') throw new InvalidInboxMessageError('messageId');
    if (props.payloadHash.trim() === '') throw new InvalidInboxMessageError('payloadHash');
    if (Number.isNaN(props.receivedAt.getTime())) throw new InvalidInboxMessageError('receivedAt');
    return new InboxMessage(props.consumerName, props.messageId, props.payloadHash, copy(props.receivedAt));
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.consumerName,
      state.messageId,
      state.payloadHash,
      copy(state.receivedAt),
      state.processedAt && copy(state.processedAt),
    );
  }

  get receivedAt(): Date {
    return copy(this._receivedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt && copy(this._processedAt);
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ensureSamePayload(payloadHash: string): void {
    if (!this.matchesPayload(payloadHash)) throw new InboxPayloadMismatchError(this.consumerName, this.messageId);
  }

  markProcessed(now: Date): void {
    if (this.isProcessed()) throw new InboxMessageAlreadyProcessedError(this.consumerName, this.messageId);
    this._processedAt = copy(now);
  }

  toState(): InboxMessageState {
    return {
      consumerName: this.consumerName,
      messageId: this.messageId,
      payloadHash: this.payloadHash,
      receivedAt: this.receivedAt,
      ...(this._processedAt === undefined ? {} : { processedAt: this.processedAt }),
    };
  }
}
