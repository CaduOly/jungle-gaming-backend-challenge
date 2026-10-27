export type Release = () => void;

/** FIFO mutex per key, standing in for a row lock (SELECT … FOR UPDATE). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<Release> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: Release;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }

  isLocked(key: string): boolean {
    return this.tails.has(key);
  }
}
