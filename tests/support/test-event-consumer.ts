import { DeleteMessageBatchCommand, type Message, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { IntegrationEventEnvelope } from '../../src/business/messaging/event/integration-event';

export interface ReceivedEvent {
  readonly envelope: IntegrationEventEnvelope;
  readonly messageGroupId?: string;
  readonly deduplicationId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const walletVersionOf = (envelope: IntegrationEventEnvelope): number | undefined => {
  const version = isRecord(envelope.data) ? envelope.data.walletVersion : undefined;
  return typeof version === 'number' ? version : undefined;
};

export const parseEnvelope = (body: string | undefined): IntegrationEventEnvelope => {
  const parsed: unknown = JSON.parse(body ?? '');
  if (!isRecord(parsed) || typeof parsed.eventId !== 'string' || typeof parsed.aggregateId !== 'string') {
    throw new Error(`Not an integration event envelope: ${body}`);
  }
  return parsed as unknown as IntegrationEventEnvelope;
};

/**
 * O que um consumer downstream correto faz: guarda a primeira entrega de cada eventId e ordena os eventos de um
 * aggregate pelo walletVersion (quando todo evento tem um), nunca pela chegada.
 */
export class EventCollector {
  private readonly received: ReceivedEvent[] = [];
  private readonly firstById = new Map<string, IntegrationEventEnvelope>();

  record(event: ReceivedEvent): void {
    this.received.push(event);
    if (!this.firstById.has(event.envelope.eventId)) this.firstById.set(event.envelope.eventId, event.envelope);
  }

  get deliveries(): readonly ReceivedEvent[] {
    return this.received;
  }

  deliveriesOf(eventId: string): ReceivedEvent[] {
    return this.received.filter((event) => event.envelope.eventId === eventId);
  }

  events(): IntegrationEventEnvelope[] {
    return [...this.firstById.values()];
  }

  eventIds(): Set<string> {
    return new Set(this.firstById.keys());
  }

  has(eventId: string): boolean {
    return this.firstById.has(eventId);
  }

  aggregateIds(): string[] {
    return [...new Set(this.events().map((event) => event.aggregateId))];
  }

  byAggregate(aggregateId: string): IntegrationEventEnvelope[] {
    const events = this.events().filter((event) => event.aggregateId === aggregateId);
    const versions = events.map(walletVersionOf);
    if (versions.some((version) => version === undefined)) return events;
    return events
      .map((event, index) => ({ event, version: versions[index] ?? 0 }))
      .sort((a, b) => a.version - b.version)
      .map(({ event }) => event);
  }
}

export interface DrainOptions {
  readonly timeoutMs?: number;
}

/** Lê (e apaga) tudo de uma fila de eventos para dentro de um EventCollector. */
export class TestEventConsumer {
  readonly collector = new EventCollector();

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async receiveOnce(waitTimeSeconds = 1): Promise<number> {
    const { Messages = [] } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitTimeSeconds,
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    for (const message of Messages) this.collector.record(this.toReceivedEvent(message));
    if (Messages.length > 0) {
      await this.client.send(
        new DeleteMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: Messages.map((message, index) => ({ Id: `${index}`, ReceiptHandle: message.ReceiptHandle })),
        }),
      );
    }
    return Messages.length;
  }

  /** Recebe até todo eventId esperado chegar, e então mais uma vez para pegar alguma duplicata atrasada. */
  async drainUntilReceived(eventIds: Iterable<string>, options: DrainOptions = {}): Promise<EventCollector> {
    const expected = [...eventIds];
    const deadline = Date.now() + (options.timeoutMs ?? 20_000);
    while (!expected.every((eventId) => this.collector.has(eventId))) {
      if (Date.now() > deadline) {
        const missing = expected.filter((eventId) => !this.collector.has(eventId));
        throw new Error(`Events never reached the queue: ${missing.length} missing (${missing.slice(0, 5).join(', ')})`);
      }
      await this.receiveOnce();
    }
    while ((await this.receiveOnce(1)) > 0);
    return this.collector;
  }

  private toReceivedEvent(message: Message): ReceivedEvent {
    const groupId = message.Attributes?.MessageGroupId;
    const deduplicationId = message.Attributes?.MessageDeduplicationId;
    return {
      envelope: parseEnvelope(message.Body),
      ...(groupId === undefined ? {} : { messageGroupId: groupId }),
      ...(deduplicationId === undefined ? {} : { deduplicationId }),
    };
  }
}
