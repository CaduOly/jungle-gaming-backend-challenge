import { Migration } from '@mikro-orm/migrations';

const KNOWN_CODES = [
  'INSUFFICIENT_FUNDS',
  'REVERSAL_INSUFFICIENT_FUNDS',
  'CURRENCY_MISMATCH',
  'WALLET_NOT_FOUND',
  'WALLET_PLAYER_MISMATCH',
  'PROVIDER_IDENTITY_MISMATCH',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_MISMATCH',
  'INVALID_REFERENCE_KIND',
  'REFERENCE_NOT_PROCESSED',
  'ALREADY_REVERSED',
  'AMOUNT_MISMATCH',
  'DUPLICATE_EXTERNAL_TRANSACTION',
  'IDEMPOTENCY_CONFLICT',
];

const checkOf = (codes: readonly string[]): string => `
ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_failure_code_valid;
ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_failure_code_valid
  CHECK (failure_code IN (${codes.map((code) => `'${code}'`).join(', ')}));
`;

/* A credit past the Money maximum is a business rejection (BALANCE_LIMIT_EXCEEDED), so the schema has to accept it. */
export class Migration20261028000100BalanceLimitExceeded extends Migration {
  override up(): void {
    this.addSql(checkOf([...KNOWN_CODES, 'BALANCE_LIMIT_EXCEEDED']));
  }

  override down(): void {
    this.addSql(checkOf(KNOWN_CODES));
  }
}
