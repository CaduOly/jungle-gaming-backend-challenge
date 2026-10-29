import type { IIdGenerator } from '../../business/shared/port/id-generator.port';

/** Time-ordered UUIDv7: new rows land at the end of the primary key index instead of all over it. */
export class UuidV7IdGenerator implements IIdGenerator {
  generate(): string {
    return Bun.randomUUIDv7();
  }
}
