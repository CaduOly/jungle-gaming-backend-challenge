/** `message` of the envelope: the name of the HTTP status in the Code catalog. */
export const Code = {
  200: 'SUCCESS',
  201: 'CREATED',
  202: 'ACCEPTED',
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
} as const;

export type HttpStatusCode = keyof typeof Code;

export const isKnownStatus = (status: number): status is HttpStatusCode => status in Code;

export const codeName = (status: number): string => (isKnownStatus(status) ? Code[status] : `HTTP_${status}`);
