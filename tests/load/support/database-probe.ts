import { Client } from 'pg';
import { findWalletInconsistencies } from '../../support/assert-wallet-consistency';
import { pool } from './wagering-api';

export interface OutboxLag {
  readonly events: number;
  readonly unpublished: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

const toNumber = (value: unknown): number => (value === null || value === undefined ? Number.NaN : Number.parseFloat(`${value}`));

export class DatabaseProbe {
  private constructor(private readonly client: Client) {}

  static async connect(url: string): Promise<DatabaseProbe> {
    const client = new Client({ connectionString: url });
    await client.connect();
    return new DatabaseProbe(client);
  }

  async close(): Promise<void> {
    await this.client.end();
  }

  async serverVersion(): Promise<string> {
    const { rows } = await this.client.query<{ server_version: string }>('SHOW server_version');
    return rows[0]?.server_version ?? 'unknown';
  }

  async unpublishedOutbox(): Promise<number> {
    const { rows } = await this.client.query<{ count: string }>(
      'SELECT count(*) AS count FROM outbox_messages WHERE published_at IS NULL',
    );
    return Number.parseInt(rows[0]?.count ?? '0', 10);
  }

  /** Waits for the publishers to drain the outbox; answers how many events are still unpublished at the deadline. */
  async waitOutboxDrained(timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let unpublished = await this.unpublishedOutbox();
    while (unpublished > 0 && Date.now() < deadline) {
      await Bun.sleep(500);
      unpublished = await this.unpublishedOutbox();
    }
    return unpublished;
  }

  /** published_at - occurred_at of the events written in [from, to). */
  async outboxLag(from: Date, to: Date): Promise<OutboxLag> {
    const { rows } = await this.client.query(
      `SELECT count(*) AS events,
              count(*) FILTER (WHERE published_at IS NULL) AS unpublished,
              percentile_cont(0.50) WITHIN GROUP (ORDER BY lag_ms) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY lag_ms) AS p95,
              percentile_cont(0.99) WITHIN GROUP (ORDER BY lag_ms) AS p99,
              max(lag_ms) AS max
         FROM (SELECT published_at, extract(epoch FROM published_at - occurred_at) * 1000 AS lag_ms
                 FROM outbox_messages WHERE occurred_at >= $1 AND occurred_at < $2) AS lag`,
      [from, to],
    );
    const row = rows[0] ?? {};
    return {
      events: Number.parseInt(`${row.events ?? 0}`, 10),
      unpublished: Number.parseInt(`${row.unpublished ?? 0}`, 10),
      p50Ms: toNumber(row.p50),
      p95Ms: toNumber(row.p95),
      p99Ms: toNumber(row.p99),
      maxMs: toNumber(row.max),
    };
  }

  /** When each transaction of `externalIds` was applied (processed_at, or created_at while still undecided). */
  async appliedAt(providerId: string, externalIds: readonly string[]): Promise<Map<string, number>> {
    const { rows } = await this.client.query<{ external_transaction_id: string; applied_ms: string }>(
      `SELECT external_transaction_id,
              extract(epoch FROM coalesce(processed_at, created_at)) * 1000 AS applied_ms
         FROM wager_transactions
        WHERE provider_id = $1 AND external_transaction_id = ANY($2)`,
      [providerId, externalIds],
    );
    return new Map(rows.map((row) => [row.external_transaction_id, Number.parseFloat(row.applied_ms)]));
  }

  async transactionStatuses(providerId: string, prefix: string): Promise<Record<string, number>> {
    const { rows } = await this.client.query<{ status: string; count: string }>(
      `SELECT status, count(*) AS count FROM wager_transactions
        WHERE provider_id = $1 AND external_transaction_id LIKE $2 GROUP BY status`,
      [providerId, `${prefix}%`],
    );
    return Object.fromEntries(rows.map((row) => [row.status, Number.parseInt(row.count, 10)]));
  }

  async inconsistentWallets(walletIds: readonly string[]): Promise<Map<string, string[]>> {
    const found = new Map<string, string[]>();
    await pool(walletIds, 1, async (walletId) => {
      const violations = await findWalletInconsistencies(this.client, walletId);
      if (violations.length > 0) found.set(walletId, violations);
    });
    return found;
  }

  async count(table: string): Promise<number> {
    const { rows } = await this.client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
    return Number.parseInt(rows[0]?.count ?? '0', 10);
  }
}
