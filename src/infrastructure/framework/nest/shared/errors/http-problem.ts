import type { DetailMessage } from '../envelope/api-response';

/** A failure that already knows its HTTP shape (raised by pipes, guards and controllers). */
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly details: readonly DetailMessage[],
    readonly data: unknown = null,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(`HTTP ${status}: ${details.map((item) => item.code).join(', ')}`);
    this.name = 'HttpProblem';
  }
}
