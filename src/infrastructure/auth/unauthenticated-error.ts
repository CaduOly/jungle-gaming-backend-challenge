/** 401: quem chamou não provou quem é. O motivo vai para o log, nunca para a resposta. */
export class UnauthenticatedError extends Error {
  constructor(reason: string) {
    super(`Unauthenticated: ${reason}`);
    this.name = 'UnauthenticatedError';
  }
}
