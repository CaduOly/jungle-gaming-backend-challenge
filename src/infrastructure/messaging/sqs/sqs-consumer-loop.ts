import {
  ChangeMessageVisibilityBatchCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { IClock } from '../../../business/shared/port/clock.port';
import { ExponentialBackoff } from '../../../business/shared/policy/exponential-backoff';
import { SystemClock } from '../../clock/system-clock';
import { parseSafeInteger } from '../../config/integer-env';
import type { SqsQueueRef } from '../../config/sqs-config';
import type { SqsConsumerConfig } from '../../config/sqs-consumer-config';
import { FaultInjector } from '../../fault-injection/fault-injector';
import { CircuitBreaker, type CircuitState } from '../../resilience/circuit-breaker';
import { PollingLoop } from '../../worker/polling-loop';
import { classifyMessageError } from './message-error-classifier';
import {
  DeadLetterReason,
  type IMessageHandler,
  type InboundMessage,
  MessageOutcome,
} from './message-handler.port';
import { SqsQueueUrl } from './sqs-queue-url';

export const DEAD_LETTER_ATTRIBUTES = {
  reason: 'dead-letter-reason',
  detail: 'dead-letter-detail',
  sourceMessageId: 'source-message-id',
  receiveCount: 'source-receive-count',
} as const;

const MAX_VISIBILITY_TIMEOUT_SECONDS = 43_200;
const MAX_DETAIL_LENGTH = 1_000;
const UNGROUPED = 'ungrouped';

export type PollResult =
  | { readonly kind: 'paused'; readonly waitMs: number }
  | { readonly kind: 'not-ready'; readonly error: unknown }
  | { readonly kind: 'received'; readonly count: number }
  | { readonly kind: 'stopped' };

export interface MessageOutcomeEvent {
  readonly message: InboundMessage | { readonly sqsMessageId: string; readonly receiveCount: number };
  readonly outcome: MessageOutcome;
  readonly durationMs: number;
  /** The outcome came from a thrown error classified as transient infrastructure. */
  readonly transient: boolean;
}

export interface SqsConsumerLoopDeps {
  readonly client: SQSClient;
  readonly queue: SqsQueueRef;
  readonly deadLetterQueue: SqsQueueRef;
  readonly handler: IMessageHandler;
  readonly config: SqsConsumerConfig;
  /** Throws (or rejects) while a dependency such as PostgreSQL is not ready; feeds the circuit breaker. */
  readonly readiness: () => Promise<void>;
  readonly clock?: IClock;
  readonly random?: () => number;
  readonly faults?: FaultInjector;
  readonly requestTimeoutMs?: number;
  /** Hooks for the metrics/log decorators (T11). */
  readonly onOutcome?: (event: MessageOutcomeEvent) => void;
  readonly onError?: (error: unknown, operation: string) => void;
  readonly onCircuitStateChange?: (state: CircuitState) => void;
}

export interface StopResult {
  /** False when the shutdown timeout expired with messages still in flight. */
  readonly graceful: boolean;
}

interface Received {
  readonly sqs: Message;
  readonly receiptHandle: string;
  readonly sqsMessageId: string;
  readonly receiveCount: number;
  readonly groupId: string | undefined;
}

const toVisibilitySeconds = (delayMs: number): number =>
  Math.min(MAX_VISIBILITY_TIMEOUT_SECONDS, Math.max(0, Math.ceil(delayMs / 1_000)));

const truncate = (value: string): string =>
  value.length <= MAX_DETAIL_LENGTH ? value : `${value.slice(0, MAX_DETAIL_LENGTH - 1)}…`;

const isAbort = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

/**
 * Long-polls the commands queue and hands each message to the handler. Messages of one FIFO group are
 * handled in order, groups in parallel. Every message of the batch keeps its visibility extended by a
 * heartbeat until it is settled. Settling: ack → DeleteMessage (only after the handler resolved, i.e.
 * after its commit); retry → ChangeMessageVisibility with backoff, and the rest of the group in that batch
 * is handed back untouched to keep the order; dead letter → explicit SendMessage to the DLQ, then delete.
 */
export class SqsConsumerLoop {
  readonly breaker: CircuitBreaker;
  private readonly loop: PollingLoop<PollResult>;
  private readonly queueUrl: SqsQueueUrl;
  private readonly deadLetterQueueUrl: SqsQueueUrl;
  private readonly backoff: ExponentialBackoff;
  private readonly faults: FaultInjector;
  private readonly clock: IClock;
  private readonly requestTimeoutMs: number;
  private receiveAbort: AbortController | undefined;
  private readonly handlerAbort = new AbortController();

  constructor(private readonly deps: SqsConsumerLoopDeps) {
    const { config } = deps;
    this.clock = deps.clock ?? new SystemClock();
    this.faults = deps.faults ?? FaultInjector.none();
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 5_000;
    this.queueUrl = new SqsQueueUrl(deps.client, deps.queue, this.requestTimeoutMs);
    this.deadLetterQueueUrl = new SqsQueueUrl(deps.client, deps.deadLetterQueue, this.requestTimeoutMs);
    this.backoff = new ExponentialBackoff({
      ...config.retry,
      maxAttempts: config.maxReceiveCount,
      random: deps.random ?? Math.random,
    });
    this.breaker = new CircuitBreaker({
      ...config.circuitBreaker,
      clock: this.clock,
      ...(deps.onCircuitStateChange === undefined ? {} : { onStateChange: deps.onCircuitStateChange }),
    });
    this.loop = new PollingLoop<PollResult>({
      round: () => this.pollOnce(),
      nextDelayMs: (result) => {
        if (result.kind === 'paused') return result.waitMs;
        if (result.kind === 'not-ready') return config.errorDelayMs;
        return 0;
      },
      errorDelayMs: config.errorDelayMs,
      onError: (error) => this.reportError(error, 'poll'),
    });
  }

  get isRunning(): boolean {
    return this.loop.isRunning;
  }

  /** circuit_breaker_open gauge (T11). */
  get isCircuitOpen(): boolean {
    return this.breaker.isOpen;
  }

  start(): void {
    this.loop.start();
  }

  /**
   * Stops polling (aborting the long poll), lets the messages in flight finish, hands the received but not
   * started ones back with visibility 0 and resolves. After `timeoutMs` it gives up waiting and aborts the
   * handlers' signal; whatever is unsettled reappears once its visibility timeout expires.
   */
  async stop(timeoutMs: number = this.deps.config.shutdownTimeoutMs): Promise<StopResult> {
    const stopped = this.loop.stop();
    this.receiveAbort?.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const graceful = await Promise.race([stopped.then(() => true as const), timedOut]);
    clearTimeout(timer);
    if (!graceful) this.handlerAbort.abort();
    return { graceful };
  }

  async pollOnce(): Promise<PollResult> {
    if (!this.breaker.canAttempt()) return { kind: 'paused', waitMs: Math.max(1, this.breaker.remainingOpenMs()) };
    try {
      await this.deps.readiness();
      this.breaker.recordSuccess();
    } catch (error) {
      this.breaker.recordFailure();
      return { kind: 'not-ready', error };
    }
    if (this.loop.isStopping) return { kind: 'stopped' };

    const messages = await this.receive();
    if (messages === undefined) return { kind: 'stopped' };
    if (messages.length > 0) await this.processBatch(messages);
    return { kind: 'received', count: messages.length };
  }

  private async receive(): Promise<Received[] | undefined> {
    const { config } = this.deps;
    this.receiveAbort = new AbortController();
    try {
      const { Messages = [] } = await this.deps.client.send(
        new ReceiveMessageCommand({
          QueueUrl: await this.queueUrl.get(),
          MaxNumberOfMessages: config.maxMessages,
          WaitTimeSeconds: config.waitTimeSeconds,
          VisibilityTimeout: config.visibilityTimeoutSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId', 'SentTimestamp'],
        }),
        { abortSignal: this.receiveAbort.signal },
      );
      return Messages.flatMap((message) => {
        if (message.ReceiptHandle === undefined || message.MessageId === undefined) return [];
        return [
          {
            sqs: message,
            receiptHandle: message.ReceiptHandle,
            sqsMessageId: message.MessageId,
            receiveCount: parseSafeInteger(message.Attributes?.ApproximateReceiveCount) ?? 1,
            groupId: message.Attributes?.MessageGroupId,
          },
        ];
      });
    } catch (error) {
      if (this.loop.isStopping && isAbort(error)) return undefined;
      throw error;
    } finally {
      this.receiveAbort = undefined;
    }
  }

  private async processBatch(messages: Received[]): Promise<void> {
    const unsettled = new Set(messages);
    const heartbeat = setInterval(() => void this.extendVisibility([...unsettled]), this.deps.config.heartbeatIntervalMs);
    const groups = new Map<string, Received[]>();
    for (const message of messages) {
      const key = message.groupId ?? UNGROUPED;
      groups.set(key, [...(groups.get(key) ?? []), message]);
    }
    const settle = (message: Received) => unsettled.delete(message);
    try {
      await Promise.all([...groups.values()].map((group) => this.processGroup(group, settle)));
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async processGroup(group: Received[], settle: (message: Received) => void): Promise<void> {
    for (let index = 0; index < group.length; index++) {
      const message = group[index] as Received;
      if (this.loop.isStopping) {
        await this.release(group.slice(index), settle);
        return;
      }
      const outcome = await this.process(message);
      settle(message);
      if (outcome.kind === 'retry') {
        await this.release(group.slice(index + 1), settle);
        return;
      }
    }
  }

  private async process(message: Received): Promise<MessageOutcome> {
    const startedAt = this.clock.now().getTime();
    const rawBody = message.sqs.Body ?? '';
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch (error) {
      const outcome = MessageOutcome.deadLetter(DeadLetterReason.INVALID_JSON, (error as Error).message);
      await this.settle(message, outcome);
      this.reportOutcome({ sqsMessageId: message.sqsMessageId, receiveCount: message.receiveCount }, outcome, startedAt, false);
      return outcome;
    }

    const sentAt = parseSafeInteger(message.sqs.Attributes?.SentTimestamp);
    const inbound: InboundMessage = {
      body,
      rawBody,
      sqsMessageId: message.sqsMessageId,
      receiveCount: message.receiveCount,
      ...(message.groupId === undefined ? {} : { messageGroupId: message.groupId }),
      ...(sentAt === undefined ? {} : { sentAt: new Date(sentAt) }),
    };
    let outcome: MessageOutcome;
    let transient = false;
    try {
      outcome = await this.deps.handler.handle(inbound, this.handlerAbort.signal);
    } catch (error) {
      ({ outcome, transient } = classifyMessageError(error));
    }
    await this.settle(message, outcome);
    this.reportOutcome(inbound, outcome, startedAt, transient);
    return outcome;
  }

  private async settle(message: Received, outcome: MessageOutcome): Promise<void> {
    try {
      if (outcome.kind === 'ack') {
        this.faults.crash('crash_after_commit_before_ack');
        await this.delete(message);
      } else if (outcome.kind === 'retry') {
        const delayMs = outcome.delayMs ?? this.backoff.nextDelayMs(Math.max(1, message.receiveCount));
        await this.changeVisibility(message, toVisibilitySeconds(delayMs));
      } else {
        await this.deadLetter(message, outcome.reason, outcome.detail);
        await this.delete(message);
      }
    } catch (error) {
      this.reportError(error, `settle:${outcome.kind}`);
    }
  }

  private async deadLetter(message: Received, reason: DeadLetterReason, detail: string | undefined): Promise<void> {
    await this.deps.client.send(
      new SendMessageCommand({
        QueueUrl: await this.deadLetterQueueUrl.get(),
        MessageBody: message.sqs.Body ?? '',
        MessageGroupId: message.groupId ?? UNGROUPED,
        MessageDeduplicationId: message.sqsMessageId,
        MessageAttributes: {
          [DEAD_LETTER_ATTRIBUTES.reason]: { DataType: 'String', StringValue: reason },
          [DEAD_LETTER_ATTRIBUTES.sourceMessageId]: { DataType: 'String', StringValue: message.sqsMessageId },
          [DEAD_LETTER_ATTRIBUTES.receiveCount]: { DataType: 'Number', StringValue: `${message.receiveCount}` },
          ...(detail === undefined || detail === ''
            ? {}
            : { [DEAD_LETTER_ATTRIBUTES.detail]: { DataType: 'String', StringValue: truncate(detail) } }),
        },
      }),
      { abortSignal: AbortSignal.timeout(this.requestTimeoutMs) },
    );
  }

  private async delete(message: Received): Promise<void> {
    await this.deps.client.send(
      new DeleteMessageCommand({ QueueUrl: await this.queueUrl.get(), ReceiptHandle: message.receiptHandle }),
      { abortSignal: AbortSignal.timeout(this.requestTimeoutMs) },
    );
  }

  private async changeVisibility(message: Received, seconds: number): Promise<void> {
    await this.deps.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl.get(),
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: seconds,
      }),
      { abortSignal: AbortSignal.timeout(this.requestTimeoutMs) },
    );
  }

  private async release(messages: Received[], settle: (message: Received) => void): Promise<void> {
    await Promise.all(
      messages.map(async (message) => {
        settle(message);
        try {
          await this.changeVisibility(message, 0);
        } catch (error) {
          this.reportError(error, 'release');
        }
      }),
    );
  }

  private async extendVisibility(messages: Received[]): Promise<void> {
    if (messages.length === 0) return;
    try {
      await this.deps.client.send(
        new ChangeMessageVisibilityBatchCommand({
          QueueUrl: await this.queueUrl.get(),
          Entries: messages.map((message, index) => ({
            Id: `${index}`,
            ReceiptHandle: message.receiptHandle,
            VisibilityTimeout: this.deps.config.visibilityTimeoutSeconds,
          })),
        }),
        { abortSignal: AbortSignal.timeout(this.requestTimeoutMs) },
      );
    } catch (error) {
      this.reportError(error, 'heartbeat');
    }
  }

  private reportOutcome(
    message: MessageOutcomeEvent['message'],
    outcome: MessageOutcome,
    startedAt: number,
    transient: boolean,
  ): void {
    try {
      this.deps.onOutcome?.({ message, outcome, durationMs: this.clock.now().getTime() - startedAt, transient });
    } catch {
      // An observer must never stop the consumer.
    }
  }

  private reportError(error: unknown, operation: string): void {
    try {
      this.deps.onError?.(error, operation);
    } catch {
      // An observer must never stop the consumer.
    }
  }
}
