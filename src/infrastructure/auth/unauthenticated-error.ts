/** 401: the caller did not prove who it is. The reason is for the logs, never for the response. */
export class UnauthenticatedError extends Error {
  constructor(reason: string) {
    super(`Unauthenticated: ${reason}`);
    this.name = 'UnauthenticatedError';
  }
}
