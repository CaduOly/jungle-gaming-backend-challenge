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
