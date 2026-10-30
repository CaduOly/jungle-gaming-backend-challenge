/** Journal por transação das operações inversas: o que um rollback reaplica, da mais nova para a mais velha. */
export class UndoLog {
  private readonly steps: (() => void)[] = [];

  record(step: () => void): void {
    this.steps.push(step);
  }

  rollback(): void {
    for (const step of this.steps.reverse()) step();
    this.steps.length = 0;
  }

  get size(): number {
    return this.steps.length;
  }
}
