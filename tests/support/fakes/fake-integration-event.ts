import {
  IntegrationEvent,
  type IntegrationEventProps,
} from '../../../src/business/messaging/event/integration-event';

export interface FakeEventData {
  readonly walletId: string;
  readonly amount: string;
  readonly walletVersion: number;
}

export class FakeIntegrationEvent extends IntegrationEvent<FakeEventData> {
  readonly eventType = 'FakeHappened';
  readonly version = 2;
  readonly aggregateType = 'Wallet';

  constructor(props: IntegrationEventProps<FakeEventData>) {
    super(props);
  }
}

let sequence = 0;

export const aFakeEvent = (overrides: Partial<IntegrationEventProps<FakeEventData>> = {}): FakeIntegrationEvent => {
  sequence += 1;
  return new FakeIntegrationEvent({
    eventId: `event-${sequence}`,
    aggregateId: 'wallet-1',
    correlationId: 'correlation-1',
    causationId: 'message-1',
    occurredAt: new Date('2026-07-29T15:00:00.000Z'),
    data: { walletId: 'wallet-1', amount: '25.00', walletVersion: sequence },
    ...overrides,
  });
};
