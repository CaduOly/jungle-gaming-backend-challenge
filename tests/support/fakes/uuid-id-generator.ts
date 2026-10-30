import type { IIdGenerator } from '../../../src/business/shared/port/id-generator.port';
import { uuidv7 } from '../uuid';

/** Ids UUIDv7, para as suítes cujos ids caem em colunas uuid do schema real. */
export class UuidIdGenerator implements IIdGenerator {
  generate(): string {
    return uuidv7();
  }
}
