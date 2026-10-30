/** Um destination do pino que guarda cada linha JSON em memória, já parseada, para as verificações de log. */
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
