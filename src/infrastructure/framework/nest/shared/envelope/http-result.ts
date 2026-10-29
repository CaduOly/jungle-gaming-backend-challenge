import type { DetailMessage } from './api-response';

/** What a business controller returns: the interceptor turns it into the status and the envelope. */
export class HttpResult<T> {
  constructor(
    readonly status: number,
    readonly data: T,
    readonly details: readonly DetailMessage[] = [],
  ) {}

  static ok<T>(data: T, details: readonly DetailMessage[] = []): HttpResult<T> {
    return new HttpResult(200, data, details);
  }

  static created<T>(data: T): HttpResult<T> {
    return new HttpResult(201, data);
  }
}
