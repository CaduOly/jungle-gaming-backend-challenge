import { describe, expect, it } from 'bun:test';
import { createJsonLog } from './json-log';

describe('createJsonLog', () => {
  it('writes one JSON line with the base fields, the event and its fields', () => {
    const lines: string[] = [];
    createJsonLog({ instanceId: 'app-1' }, (line) => lines.push(line))('wager.processed', { status: 'PROCESSED' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ instanceId: 'app-1', event: 'wager.processed', status: 'PROCESSED' });
    expect(JSON.parse(lines[0] ?? '').time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('turns an error into its name and message', () => {
    const lines: string[] = [];
    createJsonLog({}, (line) => lines.push(line))('worker.error', { error: new TypeError('boom') });
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ error: 'TypeError: boom' });
  });
});
