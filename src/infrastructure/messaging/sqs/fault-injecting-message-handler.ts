import type { FaultInjector } from '../../fault-injection/fault-injector';
import type { IMessageHandler, InboundMessage, MessageOutcome } from './message-handler.port';

/** `slow_handler`: segura toda mensagem por FAULT_SLOW_HANDLER_MS antes de tratar (testes de shutdown). */
export class FaultInjectingMessageHandler implements IMessageHandler {
  constructor(
    private readonly inner: IMessageHandler,
    private readonly faults: FaultInjector,
  ) {}

  async handle(message: InboundMessage, signal: AbortSignal): Promise<MessageOutcome> {
    if (this.faults.isActive('slow_handler')) await Bun.sleep(this.faults.slowHandlerMs);
    return this.inner.handle(message, signal);
  }
}
