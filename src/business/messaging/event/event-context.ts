/** Envelope fields a concrete event factory needs besides its own aggregate and data. */
export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
}
