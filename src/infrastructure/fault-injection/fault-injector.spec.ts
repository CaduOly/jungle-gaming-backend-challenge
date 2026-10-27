import { describe, expect, it } from 'bun:test';
import { FaultInjector, InjectedFaultError } from './fault-injector';

describe('FaultInjector', () => {
  it('is inert when FAULT_INJECTION is absent or empty', () => {
    expect(FaultInjector.fromEnv({}).isActive('fail_outbox_insert')).toBe(false);
    expect(() => FaultInjector.fromEnv({ FAULT_INJECTION: ' ' }).trip('fail_outbox_insert')).not.toThrow();
  });

  it('trips the configured points', () => {
    const faults = FaultInjector.fromEnv({ FAULT_INJECTION: ' fail_outbox_insert ' });
    expect(() => faults.trip('fail_outbox_insert')).toThrow(InjectedFaultError);
  });

  it('rejects unknown points so a typo never silently disables a fault', () => {
    expect(() => FaultInjector.fromEnv({ FAULT_INJECTION: 'fail_outbox_insret' })).toThrow('Unknown FAULT_INJECTION');
  });
});
