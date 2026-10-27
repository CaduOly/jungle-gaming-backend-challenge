export interface SqlClient {
  query<Row extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

export class WalletConsistencyError extends Error {
  constructor(
    readonly walletId: string,
    readonly violations: readonly string[],
  ) {
    super(`Wallet ${walletId} is inconsistent:\n- ${violations.join('\n- ')}`);
    this.name = 'WalletConsistencyError';
  }
}

/*
 * Expected schema (created in T07):
 *   wallets(id, balance numeric, version int)
 *   wallet_ledger_entries(wallet_id, seq bigserial, direction 'CREDIT'|'DEBIT', amount numeric,
 *                         balance_before numeric, balance_after numeric, wallet_version int)
 * All arithmetic runs in SQL on numeric, so no monetary value ever becomes a JS number.
 */
const CONSISTENCY_SQL = `
WITH wallet AS (
  SELECT id, balance, version FROM wallets WHERE id = $1
),
entries AS (
  SELECT seq, direction, amount, balance_before, balance_after, wallet_version,
         LAG(balance_after) OVER (ORDER BY seq) AS previous_after,
         LAG(wallet_version) OVER (ORDER BY seq) AS previous_version,
         ROW_NUMBER() OVER (ORDER BY seq) AS position,
         COUNT(*) OVER () AS total
  FROM wallet_ledger_entries
  WHERE wallet_id = $1
),
totals AS (
  SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount WHEN 'DEBIT' THEN -amount END), 0) AS net,
         COUNT(*) AS entry_count
  FROM entries
)
SELECT format('balance %s differs from ledger sum %s', w.balance, t.net) AS violation
  FROM wallet w, totals t WHERE w.balance <> t.net
UNION ALL
SELECT format('wallet.version %s with no ledger entries (expected 1)', w.version)
  FROM wallet w, totals t WHERE t.entry_count = 0 AND w.version <> 1
UNION ALL
SELECT format('seq %s has unknown direction %s', e.seq, e.direction)
  FROM entries e WHERE e.direction NOT IN ('CREDIT', 'DEBIT')
UNION ALL
SELECT format('seq %s arithmetic broken: %s %s %s <> %s', e.seq, e.balance_before, e.direction, e.amount, e.balance_after)
  FROM entries e
  WHERE e.balance_after <> e.balance_before + CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END
UNION ALL
SELECT format('seq %s balance_before %s should be 0 for the first entry', e.seq, e.balance_before)
  FROM entries e WHERE e.position = 1 AND e.balance_before <> 0
UNION ALL
SELECT format('seq %s balance_before %s does not chain from previous balance_after %s', e.seq, e.balance_before, e.previous_after)
  FROM entries e WHERE e.position > 1 AND e.balance_before <> e.previous_after
UNION ALL
SELECT format('seq %s wallet_version %s is not greater than previous %s', e.seq, e.wallet_version, e.previous_version)
  FROM entries e WHERE e.position > 1 AND e.wallet_version <= e.previous_version
UNION ALL
SELECT format('last wallet_version %s differs from wallet.version %s', e.wallet_version, w.version)
  FROM entries e, wallet w WHERE e.position = e.total AND e.wallet_version <> w.version
UNION ALL
SELECT format('last balance_after %s differs from wallet.balance %s', e.balance_after, w.balance)
  FROM entries e, wallet w WHERE e.position = e.total AND e.balance_after <> w.balance
`;

export const findWalletInconsistencies = async (client: SqlClient, walletId: string): Promise<string[]> => {
  const exists = await client.query<{ found: boolean }>('SELECT EXISTS (SELECT 1 FROM wallets WHERE id = $1) AS found', [walletId]);
  if (exists.rows[0]?.found !== true) return [`wallet ${walletId} not found`];
  const { rows } = await client.query<{ violation: string }>(CONSISTENCY_SQL, [walletId]);
  return rows.map((row) => row.violation);
};

export const assertWalletConsistency = async (client: SqlClient, walletId: string): Promise<void> => {
  const violations = await findWalletInconsistencies(client, walletId);
  if (violations.length > 0) throw new WalletConsistencyError(walletId, violations);
};
