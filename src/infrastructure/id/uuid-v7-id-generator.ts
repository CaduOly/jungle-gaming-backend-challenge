import type { IIdGenerator } from '../../business/shared/port/id-generator.port';

/** Time-ordered ids: new rows land at the end of the btree indexes instead of splitting random pages. */
export class UuidV7IdGenerator implements IIdGenerator {
  generate(): string {
    return Bun.randomUUIDv7();
  }
}
