import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type InMemoryHttpApp, startInMemoryHttpApp } from './support/in-memory-http-app';

const COMMON = ['401', '500', '503'];
const BODY = ['413', '415'];

/** docs/http-contract.md, per route: every status the endpoint can answer. */
const STATUS_TABLE: Record<string, string[]> = {
  'post /wallets': ['201', '400', '409', ...BODY, ...COMMON],
  'get /wallets/{walletId}': ['200', '400', '404', ...COMMON],
  'get /wallets/{walletId}/ledger': ['200', '400', '404', ...COMMON],
  'post /wallets/{walletId}/reconciliation': ['200', '400', '404', ...COMMON],
  'post /wagering/transactions': ['200', '202', '400', '403', '404', '409', '422', ...BODY, ...COMMON],
  'get /wagering/transactions/{transactionId}': ['200', '400', '404', ...COMMON],
  'get /providers/{providerId}/wagering/transactions/{externalTransactionId}': ['200', '400', '403', '404', ...COMMON],
  'get /i18n': ['200', '500'],
};

const RAW_ROUTES = /^\/(docs|health)(\/|-|$)/;

type MediaType = { schema?: { allOf?: Array<{ $ref?: string }> }; examples?: Record<string, { value: { code: number } }> };
type ResponseObject = { description?: string; content?: Record<string, MediaType> };
type Operation = { responses: Record<string, ResponseObject>; parameters?: unknown[]; security?: unknown };
type Doc = {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, { properties: Record<string, unknown> } | undefined>;
    securitySchemes?: Record<string, unknown>;
  };
};

describe('OpenAPI document', () => {
  let http: InMemoryHttpApp;
  let doc: Doc;
  let routes: string[];

  beforeAll(async () => {
    http = await startInMemoryHttpApp();
    doc = (await (await fetch(`${http.baseUrl}/docs-json`)).json()) as Doc;
    const express = http.app.getHttpAdapter().getInstance();
    routes = (express.router ?? express._router).stack
      .filter((layer: { route?: unknown }) => layer.route !== undefined)
      .flatMap((layer: { route: { path: string; methods: Record<string, boolean> } }) =>
        Object.keys(layer.route.methods).map(
          (method) => `${method} ${layer.route.path.replace(/:([A-Za-z]+)/g, '{$1}')}`,
        ),
      )
      .filter((route: string) => !RAW_ROUTES.test(route.split(' ')[1] ?? ''));
  });

  afterAll(() => http?.close());

  it('documents every registered business route, and only those, with the statuses of the contract table', () => {
    expect([...routes].sort()).toEqual(Object.keys(STATUS_TABLE).sort());
    for (const route of routes) {
      const [method, path] = route.split(' ') as [string, string];
      const operation = doc.paths[path]?.[method];
      expect({ route, statuses: Object.keys(operation?.responses ?? {}).sort() }).toEqual({
        route,
        statuses: [...(STATUS_TABLE[route] ?? [])].sort(),
      });
    }
  });

  it('wraps every response in the envelope and gives each status a named example', () => {
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          const content = response.content?.['application/json'];
          const where = `${method} ${path} ${status}`;
          expect({ where, envelope: content?.schema?.allOf?.[0]?.$ref }).toEqual({
            where,
            envelope: '#/components/schemas/ApiResponseEnvelopeDto',
          });
          const examples = Object.values(content?.examples ?? {});
          expect({ where, examples: examples.length > 0 }).toEqual({ where, examples: true });
          for (const example of examples) expect(example.value.code).toBe(Number.parseInt(status, 10));
        }
      }
    }
    expect(doc.components.schemas.DetailMessageDto).toBeDefined();
  });

  it('requires the Idempotency-Key header and bearer auth on submissions', () => {
    const submit = doc.paths['/wagering/transactions']?.post;
    expect(submit?.parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }));
    expect(submit?.security).toEqual([{ bearer: [] }]);
    expect(doc.components.securitySchemes?.bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(doc.paths['/i18n']?.get?.security).toBeUndefined();
  });

  it('documents money as a string with the amount pattern, never as a number', () => {
    for (const name of ['MoneyDto', 'MoneyRequestDto']) {
      expect(doc.components.schemas[name]?.properties.amount).toMatchObject({
        type: 'string',
        pattern: '^(0|[1-9]\\d{0,17})\\.\\d{2}$',
      });
    }
  });

  it('tells where the 413 limit comes from on every body route', () => {
    for (const operation of [doc.paths['/wallets']?.post, doc.paths['/wagering/transactions']?.post]) {
      expect(operation?.responses['413']?.description).toContain('HTTP_BODY_LIMIT');
    }
  });

  it('names the examples the contract calls out', () => {
    const responses = doc.paths['/wagering/transactions']?.post?.responses ?? {};
    const names = (status: string) => Object.keys(responses[status]?.content?.['application/json']?.examples ?? {});
    expect(names('422')).toContain('insufficientFunds');
    expect(names('409')).toContain('idempotencyConflict');
    expect(names('202')).toContain('pendingReference');
    expect(names('503')).toContain('serviceUnavailable');
  });
});
