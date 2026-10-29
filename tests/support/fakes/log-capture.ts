/** A pino destination that keeps every JSON line in memory, parsed, for the log assertions. */
export class LogCapture {
  readonly raw: string[] = [];

  write(line: string): void {
    this.raw.push(line);
  }

  get lines(): Record<string, unknown>[] {
    return this.raw.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  find(message: string): Record<string, unknown> | undefined {
    return this.lines.find((line) => line.message === message);
  }

  clear(): void {
    this.raw.length = 0;
  }
}
