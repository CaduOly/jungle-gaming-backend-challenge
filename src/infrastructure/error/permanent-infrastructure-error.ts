/** Non-retryable integrity failure raised by the database (e.g. an immutability trigger): a bug, never a retry. */
export class PermanentInfrastructureError extends Error {
  constructor(
    message: string,
    readonly sqlState: string | undefined,
    options: { cause: unknown },
  ) {
    super(message, options);
    this.name = 'PermanentInfrastructureError';
  }
}
