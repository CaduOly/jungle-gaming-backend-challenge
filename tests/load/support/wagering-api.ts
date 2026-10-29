export const LOAD_PROVIDER = 'provider-load';
export const INITIAL_BALANCE = '1000000.00';

export interface SeededWallet {
  readonly id: string;
  readonly playerId: string;
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer dev:${LOAD_PROVIDER}`,
};

/** Runs `work` over `items` with at most `concurrency` in flight. */
export const pool = async <T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
};

export const seedWallets = (baseUrl: string, count: number): Promise<SeededWallet[]> =>
  pool(
    Array.from({ length: count }, () => crypto.randomUUID()),
    16,
    async (playerId) => {
      const response = await fetch(`${baseUrl}/wallets`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ playerId, initialBalance: { amount: INITIAL_BALANCE, currency: 'BRL' } }),
      });
      if (response.status !== 201) throw new Error(`POST /wallets answered ${response.status}: ${await response.text()}`);
      const { data } = (await response.json()) as { data: { id: string } };
      return { id: data.id, playerId };
    },
  );

export interface ReconciliationOutcome {
  readonly walletId: string;
  readonly status: number;
  readonly consistent: boolean;
}

export const reconcile = (baseUrl: string, walletIds: readonly string[]): Promise<ReconciliationOutcome[]> =>
  pool(walletIds, 16, async (walletId) => {
    const response = await fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST', headers });
    const body = (await response.json().catch(() => ({}))) as { data?: { consistent?: boolean } };
    return { walletId, status: response.status, consistent: body.data?.consistent === true };
  });
