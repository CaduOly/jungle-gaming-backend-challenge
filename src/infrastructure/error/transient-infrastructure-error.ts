/** Retryable infrastructure failure (lock timeout, deadlock, lost connection): HTTP 503, SQS visibility backoff. */
export class TransientInfrastructureError extends Error {
  constructor(
    message: string,
    readonly sqlState: string | undefined,
    options: { cause: unknown },
  ) {
    super(message, options);
    this.name = 'TransientInfrastructureError';
  }
}
