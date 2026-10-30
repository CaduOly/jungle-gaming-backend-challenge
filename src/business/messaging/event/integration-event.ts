import { deepFreeze } from './deep-freeze';
import { InvalidIntegrationEventError } from '../error/invalid-integration-event-error';
import { type Jsonify, toJsonValue } from './json';

export interface IntegrationEventProps<T> {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  /** Vira `never` para tudo que não é JSON puro, então esse tipo de dado não passa. */
  readonly data: Jsonify<T>;
}

export interface IntegrationEventEnvelope<T = unknown> {
  readonly eventId: string;
  readonly eventType: string;
  readonly version: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly data: T;
}

const isBlank = (value: string): boolean => value.trim() === '';

/**
 * `data` tem que ser JSON puro (string, number, boolean, array, objeto), nunca instância de value object,
 * para o envelope ficar estável e versionável no broker. Isso é garantido pelo `Jsonify` em tempo de compilação
 * e por um round trip de JSON em runtime.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  abstract readonly aggregateType: string;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    if (isBlank(props.eventId)) throw new InvalidIntegrationEventError('eventId');
    if (isBlank(props.aggregateId)) throw new InvalidIntegrationEventError('aggregateId');
    if (isBlank(props.correlationId)) throw new InvalidIntegrationEventError('correlationId');
    if (props.causationId !== undefined && isBlank(props.causationId)) {
      throw new InvalidIntegrationEventError('causationId');
    }
    if (Number.isNaN(props.occurredAt.getTime())) throw new InvalidIntegrationEventError('occurredAt');

    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt.getTime());
    this.data = deepFreeze(toJsonValue(props.data as T));
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateType: this.aggregateType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      data: toJsonValue(this.data) as T,
    };
  }
}
