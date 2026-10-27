import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { assertWalletConsistency, WalletConsistencyError } from '../../support/assert-wallet-consistency';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { uuidv7 } from '../../support/uuid';

// Minimal stand-in for the T07 schema: only the columns the helper reads, no constraints,
// so the test can insert deliberately broken ledgers.
const STAND_IN_SCHEMA = `
CREATE TABLE wallets (id uuid PRIMARY KEY, balance numeric(20,2) NOT NULL, version int NOT NULL);
CREATE TABLE wallet_ledger_entries (
  seq bigserial PRIMARY KEY,
  wallet_id uuid NOT NULL,
  direction text NOT NULL,
  amount numeric(20,2) NOT NULL,
  balance_before numeric(20,2) NOT NULL,
  balance_after numeric(20,2) NOT NULL,
  wallet_version int NOT NULL
);`;

type Entry = readonly [direction: string, amount: string, before: string, after: string, version: number];

describe('assertWalletConsistency', () => {
  let database: TestDatabase;
  let client: Client;

  const seedWallet = async (balance: string, version: number, entries: readonly Entry[]): Promise<string> => {
    const walletId = uuidv7();
    await client.query('INSERT INTO wallets (id, balance, version) VALUES ($1, $2, $3)', [walletId, balance, version]);
    for (const [direction, amount, before, after, walletVersion] of entries) {
      await client.query(
        `INSERT INTO wallet_ledger_entries (wallet_id, direction, amount, balance_before, balance_after, wallet_version)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [walletId, direction, amount, before, after, walletVersion],
      );
    }
    return walletId;
  };

  const violationsOf = async (walletId: string): Promise<readonly string[]> => {
    const error = await assertWalletConsistency(client, walletId).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(WalletConsistencyError);
    return (error as WalletConsistencyError).violations;
  };

  beforeAll(async () => {
    await ensureInfraUp();
    database = await createTestDatabase();
    client = new Client({ connectionString: database.url });
    await client.connect();
    await client.query(STAND_IN_SCHEMA);
  });

  afterAll(async () => {
    await client?.end();
    await database?.drop();
  });

  it('accepts a wallet opened with zero balance and no entries', async () => {
    const walletId = await seedWallet('0.00', 1, []);
    await assertWalletConsistency(client, walletId);
  });

  it('accepts a coherent ledger chain', async () => {
    const walletId = await seedWallet('70.10', 4, [
      ['CREDIT', '100.00', '0.00', '100.00', 1],
      ['DEBIT', '80.00', '100.00', '20.00', 2],
      ['CREDIT', '50.10', '20.00', '70.10', 4],
    ]);
    await assertWalletConsistency(client, walletId);
  });

  it('flags a balance that does not match the ledger sum', async () => {
    const walletId = await seedWallet('25.00', 2, [
      ['CREDIT', '100.00', '0.00', '100.00', 1],
      ['DEBIT', '80.00', '100.00', '20.00', 2],
    ]);
    const violations = await violationsOf(walletId);
    expect(violations).toContain('balance 25.00 differs from ledger sum 20.00');
    expect(violations).toContain('last balance_after 20.00 differs from wallet.balance 25.00');
  });

  it('flags a broken before/after chain and bad arithmetic', async () => {
    const walletId = await seedWallet('20.00', 2, [
      ['CREDIT', '100.00', '0.00', '100.00', 1],
      ['DEBIT', '80.00', '90.00', '20.00', 2],
    ]);
    const violations = await violationsOf(walletId);
    expect(violations.some((v) => v.includes('does not chain from previous balance_after 100.00'))).toBe(true);
    expect(violations.some((v) => v.includes('arithmetic broken'))).toBe(true);
  });

  it('flags non increasing wallet_version and a last version different from the wallet', async () => {
    const walletId = await seedWallet('20.00', 3, [
      ['CREDIT', '100.00', '0.00', '100.00', 2],
      ['DEBIT', '80.00', '100.00', '20.00', 2],
    ]);
    const violations = await violationsOf(walletId);
    expect(violations.some((v) => v.includes('wallet_version 2 is not greater than previous 2'))).toBe(true);
    expect(violations).toContain('last wallet_version 2 differs from wallet.version 3');
  });

  it('flags a first entry that does not start from zero and an unknown direction', async () => {
    const walletId = await seedWallet('10.00', 1, [['BONUS', '10.00', '5.00', '15.00', 1]]);
    const violations = await violationsOf(walletId);
    expect(violations.some((v) => v.includes('should be 0 for the first entry'))).toBe(true);
    expect(violations.some((v) => v.includes('unknown direction BONUS'))).toBe(true);
  });

  it('flags a missing wallet', async () => {
    expect(await violationsOf(uuidv7())).toHaveLength(1);
  });
});
