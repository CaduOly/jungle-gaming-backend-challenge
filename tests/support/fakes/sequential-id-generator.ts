import type { IIdGenerator } from '../../../src/business/shared/port/id-generator.port';

/** Deterministic ids (`<prefix>-0001`, `<prefix>-0002`, …) that keep test failures readable. */
export class SequentialIdGenerator implements IIdGenerator {
  private next = 0;

  constructor(private readonly prefix = 'id') {}

  generate(): string {
    this.next += 1;
    return `${this.prefix}-${this.next.toString().padStart(4, '0')}`;
  }
}

/**
 * Deterministic UUID-shaped ids (`00000000-0000-7000-a000-000000000001`, …) for the ids the use cases validate as
 * UUIDs (wallets): still readable by their last digits.
 */
export class SequentialUuidGenerator implements IIdGenerator {
  private next = 0;

  generate(): string {
    this.next += 1;
    return `00000000-0000-7000-a000-${this.next.toString().padStart(12, '0')}`;
  }
}

/** The UUID-shaped player id number `n`, e.g. aPlayerId(1) = `00000000-0000-4000-8000-000000000001`. */
export const aPlayerId = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
