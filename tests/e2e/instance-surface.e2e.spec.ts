import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type InMemoryHttpApp, startInMemoryHttpApp } from './support/in-memory-http-app';

const headers = { 'Content-Type': 'application/json', 'X-Provider-Id': 'provider-a' };

describe('what a replica exposes about itself', () => {
  let http: InMemoryHttpApp;

  beforeAll(async () => {
    http = await startInMemoryHttpApp({
      instanceId: 'app-7',
      readinessDetails: () => ({ instanceId: 'app-7', roles: ['api'], circuitBreaker: 'closed' }),
      env: { HTTP_REQUEST_TIMEOUT_MS: '200' },
    });
  });

  afterAll(() => http?.close());

  it('names the replica in X-Instance-Id on every answer, errors included', async () => {
    const live = await fetch(`${http.baseUrl}/health/live`);
    const missing = await fetch(`${http.baseUrl}/wallets/not-a-uuid`, { headers });
    expect(live.headers.get('x-instance-id')).toBe('app-7');
    expect(missing.headers.get('x-instance-id')).toBe('app-7');
  });

  it('adds the instance details to /health/ready', async () => {
    const ready = await fetch(`${http.baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: 'ready',
      checks: {},
      instanceId: 'app-7',
      roles: ['api'],
      circuitBreaker: 'closed',
    });
  });

  it('answers 503 with Retry-After when the storage stops answering, instead of hanging', async () => {
    http.uow.hanging = true;
    try {
      const started = Date.now();
      const response = await fetch(`${http.baseUrl}/wallets`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1', initialBalance: { amount: '1.00', currency: 'BRL' } }),
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('3');
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      http.uow.hanging = false;
    }
  });
});
