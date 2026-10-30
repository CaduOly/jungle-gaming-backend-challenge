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
import { parseDecimalInteger } from '../../config/integer-env';
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
  /** O outcome veio de um erro lançado classificado como infraestrutura transiente. */
  readonly transient: boolean;
}

export interface SqsConsumerLoopDeps {
  readonly client: SQSClient;
  readonly queue: SqsQueueRef;
  readonly deadLetterQueue: SqsQueueRef;
  readonly handler: IMessageHandler;
  readonly config: SqsConsumerConfig;
  /** Lança (ou rejeita) enquanto uma dependência como o PostgreSQL não está ready, alimenta o circuit breaker. */
  readonly readiness: () => Promise<void>;
  readonly clock?: IClock;
  readonly random?: () => number;
  readonly faults?: FaultInjector;
  readonly requestTimeoutMs?: number;
  /** Hooks para os decorators de métricas/log. */
  readonly onOutcome?: (event: MessageOutcomeEvent) => unknown;
  readonly onError?: (error: unknown, operation: string) => unknown;
  readonly onCircuitStateChange?: (state: CircuitState) => void;
}

export interface StopResult {
  /** False quando o timeout do shutdown estourou com mensagens ainda em andamento. */
  readonly graceful: boolean;
}

interface Received {
  readonly sqs: Message;
  readonly receiptHandle: string;
  readonly sqsMessageId: string;
  readonly receiveCount: number;
  readonly groupId: string | undefined;
  readonly receivedAt: number;
}

const toVisibilitySeconds = (delayMs: number): number =>
  Math.min(MAX_VISIBILITY_TIMEOUT_SECONDS, Math.max(0, Math.ceil(delayMs / 1_000)));

const truncate = (value: string): string =>
  value.length <= MAX_DETAIL_LENGTH ? value : `${value.slice(0, MAX_DETAIL_LENGTH - 1)}…`;

/** Um observer nunca pode parar o consumer, seja lançando erro ou retornando promise rejeitada. */
const observe = (callback: () => unknown): void => {
  try {
    Promise.resolve(callback()).catch(() => undefined);
  } catch {
    // ver acima
  }
};

const isAbort = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Resolve depois de `ms`, ou assim que o `signal` abortar. */
const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/** Settled: ack ou dead letter. Handed back: devolvida ao SQS com delay de visibility, ainda sem processar. */
type Disposition = { readonly handedBack: false } | { readonly handedBack: true; readonly visibilitySeconds: number };

const SETTLED: Disposition = { handedBack: false };

/** Vai para o onError (operation `heartbeat`) para cada entrada que o SQS recusou estender. */
export class VisibilityExtensionRejectedError extends Error {
  override readonly name = 'VisibilityExtensionRejectedError';

  constructor(
    readonly sqsMessageId: string,
    readonly code: string | undefined,
    detail: string | undefined,
  ) {
    super(`SQS refused to extend the visibility of ${sqsMessageId}: ${code ?? 'unknown'} ${detail ?? ''}`.trim());
  }
}

/**
 * Faz long-poll da fila de comandos e entrega cada mensagem ao handler. Mensagens do mesmo grupo FIFO são
 * tratadas em ordem, e os grupos em paralelo. Toda mensagem do batch tem a visibility estendida por um heartbeat
 * até ser settled. Settle: ack → DeleteMessage (só depois que o handler resolveu, ou seja, depois do commit);
 * dead letter → SendMessage explícito para a DLQ e depois delete.
 *
 * O retry fica no processo, e a contagem que manda a mensagem para a DLQ também. Mensagem que falhou é tentada de
 * novo aqui, com backoff, enquanto o heartbeat mantém ela e o resto do grupo invisíveis. Depois de uma falha o
 * readiness probe roda primeiro: enquanto o PostgreSQL está fora a falha não conta e o handler não é chamado de
 * novo até o probe passar (o breaker dita o ritmo dos probes). Quando a própria mensagem falhou
 * maxInProcessAttempts vezes seguidas ela vai para a DLQ explicitamente (retries_exhausted). Ela só volta para o
 * SQS no stop, com visibility de backoff, e o resto do grupo no batch volta com a mesma visibility.
 *
 * Por que não o receive count do SQS: ele conta entregas, não falhas. Uma tail devolvida junto com a head, ou um
 * batch devolvido num stop ou deploy, ganha receives sem nunca ter falhado, então qualquer decisão tomada em cima
 * do ApproximateReceiveCount (nossa ou do redrive) poderia mandar para a DLQ um comando que nunca foi processado.
 * Aqui a decisão da DLQ só conta as falhas da própria mensagem dentro de uma entrega, então nunca dispara antes da
 * hora; um stop reinicia essa contagem, o que só pode atrasar um dead letter, nunca adiantar. A redrive policy fica
 * como rede para um consumer que cai antes do settle, e o maxReceiveCount dela tem que ficar bem acima de qualquer
 * coisa que stops e deploys alcancem (100 por default), ele não é o limite de retry.
 *
 * Ordem FIFO: na AWS um grupo com mensagem em andamento não entrega mais nada, então a tail nunca passa a head.
 * O LocalStack não respeita esse bloqueio, uma mensagem do grupo pode ser recebida enquanto uma mais antiga do
 * mesmo grupo ainda está em andamento. Por isso a tail volta com a visibility da head em vez de 0, e por isso os
 * testes de ordem contra o LocalStack rodam um consumer só.
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
  /** Mensagens cuja chamada final no SQS (delete, dead letter, hand back) já começou, o heartbeat não mexe nelas. */
  private readonly leaving = new WeakSet<Received>();
  private handlerAbort = new AbortController();
  private stopAbort = new AbortController();

  constructor(private readonly deps: SqsConsumerLoopDeps) {
    const { config } = deps;
    this.clock = deps.clock ?? new SystemClock();
    this.faults = deps.faults ?? FaultInjector.none();
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 5_000;
    this.queueUrl = new SqsQueueUrl(deps.client, deps.queue, this.requestTimeoutMs);
    this.deadLetterQueueUrl = new SqsQueueUrl(deps.client, deps.deadLetterQueue, this.requestTimeoutMs);
    this.backoff = new ExponentialBackoff({
      ...config.retry,
      maxAttempts: config.maxInProcessAttempts,
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

  /** circuit_breaker_open gauge. */
  get isCircuitOpen(): boolean {
    return this.breaker.isOpen;
  }

  start(): void {
    const wasRunning = this.loop.isRunning;
    this.loop.start();
    if (wasRunning) return;
    this.handlerAbort = new AbortController();
    this.stopAbort = new AbortController();
  }

  /**
   * Para o polling (abortando o long poll e qualquer espera de retry in-process), deixa os handlers em andamento
   * terminarem, devolve a mensagem que espera retry com a visibility de backoff, as recebidas mas não iniciadas com
   * visibility 0, e resolve. Depois de `timeoutMs` desiste de esperar e aborta o signal dos handlers, e o que não
   * foi settled reaparece quando o visibility timeout dele expira.
   */
  async stop(timeoutMs: number = this.deps.config.shutdownTimeoutMs): Promise<StopResult> {
    const stopped = this.loop.stop();
    this.receiveAbort?.abort();
    this.stopAbort.abort();
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
          MessageAttributeNames: ['providerId', 'ProviderId'],
        }),
        { abortSignal: this.receiveAbort.signal },
      );
      const receivedAt = this.clock.now().getTime();
      return Messages.flatMap((message) => {
        if (message.ReceiptHandle === undefined || message.MessageId === undefined) return [];
        return [
          {
            sqs: message,
            receiptHandle: message.ReceiptHandle,
            sqsMessageId: message.MessageId,
            receiveCount: parseDecimalInteger(message.Attributes?.ApproximateReceiveCount) ?? 1,
            groupId: message.Attributes?.MessageGroupId,
            receivedAt,
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
        await this.release(group.slice(index), settle, 0);
        return;
      }
      const disposition = await this.process(message);
      settle(message);
      if (disposition.handedBack) {
        await this.release(group.slice(index + 1), settle, disposition.visibilitySeconds);
        return;
      }
    }
  }

  private async process(message: Received): Promise<Disposition> {
    const startedAt = this.clock.now().getTime();
    const rawBody = message.sqs.Body ?? '';
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch (error) {
      const outcome = MessageOutcome.deadLetter(DeadLetterReason.INVALID_JSON, (error as Error).message);
      await this.settle(message, outcome);
      this.reportOutcome({ sqsMessageId: message.sqsMessageId, receiveCount: message.receiveCount }, outcome, startedAt, false);
      return SETTLED;
    }

    const sentAt = parseDecimalInteger(message.sqs.Attributes?.SentTimestamp);
    const actorProviderId = (
      message.sqs.MessageAttributes?.providerId?.StringValue ??
      message.sqs.MessageAttributes?.ProviderId?.StringValue
    )?.trim();
    const inbound: InboundMessage = {
      body,
      rawBody,
      sqsMessageId: message.sqsMessageId,
      receiveCount: message.receiveCount,
      ...(message.groupId === undefined ? {} : { messageGroupId: message.groupId }),
      ...(sentAt === undefined ? {} : { sentAt: new Date(sentAt) }),
      ...(actorProviderId === undefined || actorProviderId === '' ? {} : { actorProviderId }),
    };
    const { maxInProcessAttempts } = this.deps.config;
    let failures = 0;
    for (;;) {
      const attemptStartedAt = this.clock.now().getTime();
      const { outcome, transient, failure } = await this.attempt(inbound);
      this.reportOutcome(inbound, outcome, attemptStartedAt, transient);
      if (outcome.kind !== 'retry') {
        await this.settle(message, outcome);
        return SETTLED;
      }
      const counted = await this.probeReadiness();
      if (counted) failures += 1;
      if (failures >= maxInProcessAttempts) {
        const detail = `failed ${failures} times in a row (receive ${message.receiveCount}): ${failure}`;
        await this.settle(message, MessageOutcome.deadLetter(DeadLetterReason.RETRIES_EXHAUSTED, detail));
        return SETTLED;
      }
      if (!(await this.untilReady())) return this.handBack(message);
      if (counted) await pause(outcome.delayMs ?? this.backoff.nextDelayMs(failures), this.stopAbort.signal);
      if (this.loop.isStopping) return this.handBack(message);
    }
  }

  /**
   * Espera, sem chamar o handler, até o readiness probe passar (true) ou o consumer parar (false).
   * Com o breaker aberto não tem probe nenhum, e half-open deixa passar um probe.
   */
  private async untilReady(): Promise<boolean> {
    while (!this.loop.isStopping) {
      if (!this.breaker.canAttempt()) {
        await pause(Math.max(1, this.breaker.remainingOpenMs()), this.stopAbort.signal);
        continue;
      }
      if (await this.probeReadiness()) return true;
      await pause(this.deps.config.errorDelayMs, this.stopAbort.signal);
    }
    return false;
  }

  private async attempt(
    inbound: InboundMessage,
  ): Promise<{ readonly outcome: MessageOutcome; readonly transient: boolean; readonly failure: string }> {
    try {
      const outcome = await this.deps.handler.handle(inbound, this.handlerAbort.signal);
      return { outcome, transient: false, failure: 'the handler asked for a retry' };
    } catch (error) {
      return { ...classifyMessageError(error), failure: messageOf(error) };
    }
  }

  /** Alimenta o breaker, false enquanto uma dependência como o PostgreSQL não está ready. */
  private async probeReadiness(): Promise<boolean> {
    try {
      await this.deps.readiness();
      this.breaker.recordSuccess();
      return true;
    } catch {
      this.breaker.recordFailure();
      return false;
    }
  }

  private async handBack(message: Received): Promise<Disposition> {
    const visibilitySeconds = toVisibilitySeconds(this.backoff.nextDelayMs(Math.max(1, message.receiveCount)));
    this.leaving.add(message);
    try {
      await this.changeVisibility(message, visibilitySeconds);
    } catch (error) {
      this.reportError(error, 'hand-back');
    }
    return { handedBack: true, visibilitySeconds };
  }

  private async settle(message: Received, outcome: MessageOutcome): Promise<void> {
    this.leaving.add(message);
    try {
      if (outcome.kind === 'ack') {
        this.faults.crash('crash_after_commit_before_ack');
        await this.delete(message);
      } else if (outcome.kind === 'dead-letter') {
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

  private async release(messages: Received[], settle: (message: Received) => void, seconds: number): Promise<void> {
    await Promise.all(
      messages.map(async (message) => {
        settle(message);
        this.leaving.add(message);
        try {
          await this.changeVisibility(message, seconds);
        } catch (error) {
          this.reportError(error, 'release');
        }
      }),
    );
  }

  /**
   * Define a visibility como visibilityTimeout mais o tempo já gasto desde o receive. Na AWS isso só segura a
   * mensagem um pouco mais depois de um crash, mas no LocalStack é obrigatório, já que ele expira o receipt handle
   * em tempo do receive + última visibility definida, então uma extensão simples faria o DeleteMessage final falhar
   * com "The receipt handle has expired". Mensagem cuja chamada final já começou é pulada, e recusa que correu junto
   * com ela também (a mensagem já foi, nada a reportar); qualquer outra entrada recusada vai para o onError como
   * VisibilityExtensionRejectedError.
   */
  private async extendVisibility(candidates: Received[]): Promise<void> {
    const messages = candidates.filter((message) => !this.leaving.has(message));
    if (messages.length === 0) return;
    const now = this.clock.now().getTime();
    try {
      const { Failed = [] } = await this.deps.client.send(
        new ChangeMessageVisibilityBatchCommand({
          QueueUrl: await this.queueUrl.get(),
          Entries: messages.map((message, index) => ({
            Id: `${index}`,
            ReceiptHandle: message.receiptHandle,
            VisibilityTimeout: Math.min(
              MAX_VISIBILITY_TIMEOUT_SECONDS,
              this.deps.config.visibilityTimeoutSeconds + toVisibilitySeconds(now - message.receivedAt),
            ),
          })),
        }),
        { abortSignal: AbortSignal.timeout(this.requestTimeoutMs) },
      );
      for (const failed of Failed) {
        const message = messages[parseDecimalInteger(failed.Id) ?? -1];
        if (message !== undefined && this.leaving.has(message)) continue;
        const error = new VisibilityExtensionRejectedError(message?.sqsMessageId ?? `entry ${failed.Id}`, failed.Code, failed.Message);
        this.reportError(error, 'heartbeat');
      }
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
    const durationMs = this.clock.now().getTime() - startedAt;
    observe(() => this.deps.onOutcome?.({ message, outcome, durationMs, transient }));
  }

  private reportError(error: unknown, operation: string): void {
    observe(() => this.deps.onError?.(error, operation));
  }
}
