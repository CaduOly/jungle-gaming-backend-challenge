import { startInMemoryHttpApp } from '../support/in-memory-http-app';
const http = await startInMemoryHttpApp();
const go = async (label: string, path: string, init: RequestInit) => {
  const r = await fetch(`${http.baseUrl}${path}`, init);
  console.log(label, r.status, (await r.text()).slice(0, 300));
};
const auth = { Authorization: 'Bearer dev:provider-a' };
await go('big', '/wallets', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: 'x'.repeat(200_000) }) });
await go('text', '/wallets', { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: 'hello' });
await go('xml', '/wallets', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/xml' }, body: '<a/>' });
await go('uri', '/wallets/%E0%A4%A', { method: 'GET', headers: auth });
await go('proto', '/wallets', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1.00","currency":"BRL","__proto__":{"x":1}}}' });
await go('proto-top', '/wallets', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"__proto__":{"x":1},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1.00","currency":"BRL"}}' });
await go('constructor', '/wallets', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"constructor":{"prototype":{"x":1}},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1.00","currency":"BRL"}}' });
await go('array', '/wallets', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '[]' });
await go('recon-nobody', `/wallets/0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1/reconciliation`, { method: 'POST', headers: auth });
await http.close();
