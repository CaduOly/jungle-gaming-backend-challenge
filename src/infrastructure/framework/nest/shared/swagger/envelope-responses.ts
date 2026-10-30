import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { type DetailMessage, detail, envelope } from '../envelope/api-response';
import type { IDetailMessage } from '../i18n/detail-message';
import { InfraDetailMessage } from '../i18n/infra.detail-message';
import { ValidationDetailMessage } from '../i18n/validation.detail-message';
import { ApiResponseEnvelopeDto, DetailMessageDto, MoneyDto } from './schemas';

const EXAMPLE_TIME = new Date('2026-07-29T15:00:00.000Z');

export interface NamedExample {
  readonly summary: string;
  readonly data?: unknown;
  readonly details?: readonly DetailMessage[];
}

export interface EnvelopeResponse {
  readonly status: number;
  readonly description: string;
  /** Schema do `data`, omitido quando `data` é null. */
  readonly model?: Type<unknown>;
  readonly examples: Readonly<Record<string, NamedExample>>;
  readonly headers?: Record<string, { description: string; schema: { type: 'string' | 'integer' } }>;
}

export const envelopeSchema = (model?: Type<unknown>) => ({
  allOf: [
    { $ref: getSchemaPath(ApiResponseEnvelopeDto) },
    { properties: { data: model === undefined ? { nullable: true, example: null } : { $ref: getSchemaPath(model) } } },
  ],
});

export const problem = (summary: string, message: IDetailMessage, field?: string, data?: unknown): NamedExample => ({
  summary,
  details: [detail(message, field)],
  ...(data === undefined ? {} : { data }),
});

/** Uma resposta por status, cada uma com os exemplos nomeados, tudo dentro do envelope. */
export const ApiEnvelopeResponses = (...responses: EnvelopeResponse[]): MethodDecorator => {
  const models = responses.flatMap((response) => (response.model === undefined ? [] : [response.model]));
  return applyDecorators(
    ApiExtraModels(ApiResponseEnvelopeDto, DetailMessageDto, MoneyDto, ...models),
    ...responses.map((response) =>
      ApiResponse({
        status: response.status,
        description: response.description,
        ...(response.headers === undefined ? {} : { headers: response.headers }),
        content: {
          'application/json': {
            schema: envelopeSchema(response.model),
            examples: Object.fromEntries(
              Object.entries(response.examples).map(([name, example]) => [
                name,
                {
                  summary: example.summary,
                  value: envelope(response.status, example.data ?? null, example.details ?? [], EXAMPLE_TIME),
                },
              ]),
            ),
          },
        },
      }),
    ),
  );
};

export const unauthorizedResponse: EnvelopeResponse = {
  status: 401,
  description: 'Missing or invalid credentials.',
  examples: { unauthorized: problem('No or invalid token', InfraDetailMessage.UNAUTHORIZED) },
};

export const serviceUnavailableResponse: EnvelopeResponse = {
  status: 503,
  description: 'Transient infrastructure failure (database down, lock timeout, deadlock). Safe to resend after Retry-After.',
  headers: { 'Retry-After': { description: 'Seconds to wait before resending.', schema: { type: 'integer' } } },
  examples: { serviceUnavailable: problem('Database unavailable', InfraDetailMessage.INFRA_UNAVAILABLE) },
};

export const internalErrorResponse: EnvelopeResponse = {
  status: 500,
  description: 'Unexpected error. No internal message or stack is exposed.',
  examples: { internalError: problem('Unexpected failure', InfraDetailMessage.INTERNAL_ERROR) },
};

/** Toda rota que lê body: tem que ser JSON e caber no limite do body parser. */
export const bodyResponses: EnvelopeResponse[] = [
  {
    status: 413,
    description: 'The body is over the size limit (HTTP_BODY_LIMIT, 100kb by default).',
    examples: { payloadTooLarge: problem('Body too large', ValidationDetailMessage.PAYLOAD_TOO_LARGE) },
  },
  {
    status: 415,
    description: 'The body is not JSON (Content-Type must be application/json).',
    examples: { unsupportedMediaType: problem('Body is text/plain', ValidationDetailMessage.UNSUPPORTED_MEDIA_TYPE) },
  },
];
