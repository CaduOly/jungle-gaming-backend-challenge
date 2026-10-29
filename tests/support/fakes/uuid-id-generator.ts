import type { IIdGenerator } from '../../../src/business/shared/port/id-generator.port';
import { uuidv7 } from '../uuid';

/** UUIDv7 ids, for suites whose ids land in uuid columns of the real schema. */
export class UuidIdGenerator implements IIdGenerator {
  generate(): string {
    return uuidv7();
  }
}
