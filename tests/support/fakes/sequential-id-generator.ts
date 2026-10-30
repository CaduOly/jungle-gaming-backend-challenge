import type { IIdGenerator } from '../../../src/business/shared/port/id-generator.port';

/** Ids determinísticos (`<prefix>-0001`, `<prefix>-0002`, …) que deixam as falhas de teste legíveis. */
export class SequentialIdGenerator implements IIdGenerator {
  private next = 0;

  constructor(private readonly prefix = 'id') {}

  generate(): string {
    this.next += 1;
    return `${this.prefix}-${this.next.toString().padStart(4, '0')}`;
  }
}

/**
 * Ids determinísticos no formato UUID (`00000000-0000-7000-a000-000000000001`, …) para os ids que os use cases
 * validam como UUID (wallets): ainda dá para ler pelos últimos dígitos.
 */
export class SequentialUuidGenerator implements IIdGenerator {
  private next = 0;

  generate(): string {
    this.next += 1;
    return `00000000-0000-7000-a000-${this.next.toString().padStart(12, '0')}`;
  }
}

/** O player id número `n` no formato UUID, por exemplo aPlayerId(1) = `00000000-0000-4000-8000-000000000001`. */
export const aPlayerId = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
