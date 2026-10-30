import type { IIdGenerator } from '../../business/shared/port/id-generator.port';

/** UUIDv7 ordenado por tempo: linha nova cai no fim do índice da primary key em vez de espalhada por ele. */
export class UuidV7IdGenerator implements IIdGenerator {
  generate(): string {
    return Bun.randomUUIDv7();
  }
}
