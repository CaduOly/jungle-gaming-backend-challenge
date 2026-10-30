/** Campos do envelope que a factory de um evento concreto precisa além do próprio aggregate e do data. */
export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
}
