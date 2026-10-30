import type { DetailMessage } from '../envelope/api-response';

/** Falha que já sabe o formato HTTP dela (lançada por pipes, guards e controllers). */
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
