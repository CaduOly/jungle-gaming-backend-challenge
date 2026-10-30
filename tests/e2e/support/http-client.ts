import { expect } from 'bun:test';
import { Code } from '../../../src/infrastructure/framework/nest/shared/envelope/status-code';

export interface Envelope {
  readonly code: number;
  readonly message: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- os payloads são verificados campo a campo em cada endpoint
  readonly data: any;
  readonly timestamp: number;
  readonly detailsMessage: Array<{ code: string; message: string; type: string; field?: string }>;
}

export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Envelope;
  readonly text: string;
}

export interface CallOptions {
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly provider?: string | null;
  readonly headers?: Record<string, string>;
}

export const client = (baseUrl: string) =>
  async (method: string, path: string, options: CallOptions = {}): Promise<Reply> => {
    const provider = options.provider === undefined ? 'provider-a' : options.provider;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(provider === null ? {} : { Authorization: `Bearer dev:${provider}` }),
        ...(options.body === undefined && options.rawBody === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      ...(options.rawBody !== undefined ? { body: options.rawBody } : {}),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text === '' ? (null as never) : JSON.parse(text) };
  };

/** O contrato do envelope: o mesmo status em `code`, o nome do Code, o horário do relógio e os códigos de detalhe. */
export const expectEnvelope = (reply: Reply, status: number, detailCodes: string[], timestamp: number): Envelope => {
  expect({ status: reply.status, details: reply.body.detailsMessage.map((item) => item.code) }).toEqual({
    status,
    details: detailCodes,
  });
  expect(Object.keys(reply.body).sort()).toEqual(['code', 'data', 'detailsMessage', 'message', 'timestamp']);
  expect(reply.body.code).toBe(status);
  expect(reply.body.message).toBe(Code[status as keyof typeof Code]);
  expect(reply.body.timestamp).toBe(timestamp);
  return reply.body;
};
