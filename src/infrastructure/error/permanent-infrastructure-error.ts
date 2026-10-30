/** Falha de integridade sem retry levantada pelo banco (ex. trigger de imutabilidade): é bug, nunca retry. */
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
