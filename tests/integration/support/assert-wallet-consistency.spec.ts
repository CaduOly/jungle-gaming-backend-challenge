import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { assertWalletConsistency, WalletConsistencyError } from '../../support/assert-wallet-consistency';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { uuidv7 } from '../../support/uuid';

// Minimal stand-in for the T07 schema: only the columns the helper reads, no constraints,
// so the test can insert deliberately broken ledgers.
const STAND_IN_SCHEMA = `
CREATE TABLE wallets (id uuid PRIMARY KEY, balance numeric(20,2), version int);
CREATE TABLE wallet_ledger_entries (
  seq bigserial PRIMARY KEY,
  wallet_id uuid NOT NULL,
  direction text,
  amount numeric(20,2),
  balance_before numeric(20,2),
  balance_after numeric(20,2),
  wallet_version int
);`;

type Entry = readonly [
  direction: string | null,
  amount: string | null,
  before: string | null,
  after: string | null,
  version: number | null,
];

describe('assertWalletConsistency', () => {
  let database: TestDatabase;
  let client: Client;

  const seedWallet = async (balance: string | null, version: number | null, entries: readonly Entry[]): Promise<string> => {
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

  const lastSeq = async (walletId: string): Promise<string> => {
    const { rows } = await client.query<{ seq: string }>(
      'SELECT max(seq)::text AS seq FROM wallet_ledger_entries WHERE wallet_id = $1',
      [walletId],
    );
    return rows[0]?.seq ?? '?';
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

  it('accepts a wallet opened with funds: OPENING at version 1 then consecutive versions', async () => {
    const walletId = await seedWallet('70.10', 3, [
      ['CREDIT', '100.00', '0.00', '100.00', 1],
      ['DEBIT', '80.00', '100.00', '20.00', 2],
      ['CREDIT', '50.10', '20.00', '70.10', 3],
    ]);
    await assertWalletConsistency(client, walletId);
  });

  it('accepts a wallet opened empty: first entry at version 2', async () => {
    const walletId = await seedWallet('5.00', 3, [
      ['CREDIT', '10.00', '0.00', '10.00', 2],
      ['DEBIT', '5.00', '10.00', '5.00', 3],
    ]);
    await assertWalletConsistency(client, walletId);
  });

  it('flags a version gap (2 -> 4)', async () => {
    const walletId = await seedWallet('70.10', 4, [
      ['CREDIT', '100.00', '0.00', '100.00', 1],
      ['DEBIT', '80.00', '100.00', '20.00', 2],
      ['CREDIT', '50.10', '20.00', '70.10', 4],
    ]);
    const seq = await lastSeq(walletId);
    expect(await violationsOf(walletId)).toEqual([`seq ${seq} wallet_version 4 does not follow previous 2`]);
  });

  it('flags a repeated version and a last version different from the wallet', async () => {
    const walletId = await seedWallet('20.00', 3, [
      ['CREDIT', '100.00', '0.00', '100.00', 2],
      ['DEBIT', '80.00', '100.00', '20.00', 2],
    ]);
    const violations = await violationsOf(walletId);
    expect(violations.some((v) => v.endsWith('wallet_version 2 does not follow previous 2'))).toBe(true);
    expect(violations).toContain('last wallet_version 2 differs from wallet.version 3');
  });

  it.each([0, 3])('flags a first version of %p', async (firstVersion) => {
    const walletId = await seedWallet('10.00', firstVersion, [['CREDIT', '10.00', '0.00', '10.00', firstVersion]]);
    const violations = await violationsOf(walletId);
    expect(violations.some((v) => v.includes(`first wallet_version ${firstVersion} must be 1`))).toBe(true);
  });

  it('flags a wallet without entries whose version moved', async () => {
    const walletId = await seedWallet('0.00', 2, []);
    expect(await violationsOf(walletId)).toEqual(['wallet.version 2 with no ledger entries (expected 1)']);
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

  it('flags a first entry that does not start from zero and an unknown direction', async () => {
    const walletId = await seedWallet('10.00', 1, [['BONUS', '10.00', '5.00', '15.00', 1]]);
    const violations = await violationsOf(walletId);
    expect(violations.some((v) => v.includes('should be 0 for the first entry'))).toBe(true);
    expect(violations.some((v) => v.includes('unknown direction BONUS'))).toBe(true);
  });

  it.each([
    ['wallet balance', null, 1, [['CREDIT', '10.00', '0.00', '10.00', 1]]],
    ['wallet version', '10.00', null, [['CREDIT', '10.00', '0.00', '10.00', 1]]],
    ['wallet version without entries', '0.00', null, []],
    ['entry direction', '10.00', 1, [[null, '10.00', '0.00', '10.00', 1]]],
    ['entry amount', '10.00', 1, [['CREDIT', null, '0.00', '10.00', 1]]],
    ['entry balance_before', '10.00', 1, [['CREDIT', '10.00', null, '10.00', 1]]],
    ['entry balance_after', '10.00', 1, [['CREDIT', '10.00', '0.00', null, 1]]],
    ['entry wallet_version', '10.00', 1, [['CREDIT', '10.00', '0.00', '10.00', null]]],
    [
      'a middle wallet_version',
      '15.00',
      3,
      [
        ['CREDIT', '10.00', '0.00', '10.00', 1],
        ['CREDIT', '5.00', '10.00', '15.00', null],
      ],
    ],
  ] as const)('does not let a NULL %s hide a violation', async (_name, balance, version, entries) => {
    const walletId = await seedWallet(balance, version, entries);
    expect((await violationsOf(walletId)).length).toBeGreaterThan(0);
  });

  it('flags a negative wallet balance', async () => {
    const walletId = await seedWallet('-5.00', 1, []);
    expect(await violationsOf(walletId)).toContain('wallet.balance -5.00 is negative');
  });

  it('flags a negative balance_after even when the chain and the sum agree', async () => {
    const walletId = await seedWallet('-10.00', 2, [
      ['CREDIT', '10.00', '0.00', '10.00', 1],
      ['DEBIT', '20.00', '10.00', '-10.00', 2],
    ]);
    const seq = await lastSeq(walletId);
    const violations = await violationsOf(walletId);
    expect(violations).toContain(`seq ${seq} balance_after -10.00 is negative`);
    expect(violations).toContain('wallet.balance -10.00 is negative');
  });

  it('flags a wallet_version 1 entry that is not a CREDIT', async () => {
    const walletId = await seedWallet('0.00', 2, [
      ['DEBIT', '10.00', '0.00', '10.00', 1],
      ['DEBIT', '10.00', '10.00', '0.00', 2],
    ]);
    const violations = await violationsOf(walletId);
    expect(violations.some((v) => v.endsWith('wallet_version 1 must be a CREDIT (OPENING), got DEBIT'))).toBe(true);
  });

  it('flags a missing wallet', async () => {
    expect(await violationsOf(uuidv7())).toHaveLength(1);
  });
});
