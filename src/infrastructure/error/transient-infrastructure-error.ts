/** Falha de infraestrutura com retry (lock timeout, deadlock, conexão perdida): HTTP 503, backoff de visibility no SQS. */
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
