import { isFailureCode } from '../../../../business/shared/error/failure-code';
import { WagerTransaction } from '../../../../business/wagering/entity/wager-transaction';
import { WagerKind } from '../../../../business/wagering/enum/wager-kind';
import { WagerTransactionStatus } from '../../../../business/wagering/enum/wager-transaction-status';
import { toDate, toMoney, toOptionalDate, toOptionalMoney, toOptionalString, toText } from './sql-values';

export interface WagerTransactionRow {
  readonly id: string;
  readonly provider_id: string;
  readonly external_transaction_id: string;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly wallet_id: string;
  readonly player_id: string;
  readonly round_id: unknown;
  readonly game_id: unknown;
  readonly kind: string;
  readonly status: string;
  readonly amount: unknown;
  readonly currency: string;
  readonly reference_external_transaction_id: unknown;
  readonly reference_transaction_id: unknown;
  readonly failure_code: unknown;
  readonly observed_balance: unknown;
  readonly attempts: number;
  readonly next_attempt_at: unknown;
  readonly created_at: unknown;
  readonly processed_at: unknown;
}

const KINDS: ReadonlySet<string> = new Set(Object.values(WagerKind));
const STATUSES: ReadonlySet<string> = new Set(Object.values(WagerTransactionStatus));

const oneOf = <T extends string>(allowed: ReadonlySet<string>, value: string, column: string): T => {
  if (!allowed.has(value)) throw new Error(`Unknown ${column} "${value}"`);
  return value as T;
};

const toFailureCode = (value: unknown) => {
  if (value === null || value === undefined) return undefined;
  if (!isFailureCode(value)) throw new Error(`Unknown failure_code "${String(value)}"`);
  return value;
};

/**
 * The observed balance is in the wallet currency, which differs from the transaction currency only on a
 * CURRENCY_MISMATCH rejection; `wallet_currency` is NULL exactly there, so the wallet row is joined for it.
 */
export const WAGER_SELECT = `
  SELECT t.id, t.provider_id, t.external_transaction_id, t.idempotency_key, t.payload_hash, t.wallet_id,
         t.player_id, t.round_id, t.game_id, t.kind, t.status, t.amount, t.currency,
         t.reference_external_transaction_id, t.reference_transaction_id, t.failure_code, t.observed_balance,
         t.attempts, t.next_attempt_at, t.created_at, t.processed_at, w.currency AS wallet_currency_of_row
    FROM wager_transactions t
    JOIN wallets w ON w.id = t.wallet_id`;

export interface WagerTransactionSelectRow extends WagerTransactionRow {
  readonly wallet_currency_of_row: string;
}

export const wagerTransactionFromRow = (row: WagerTransactionSelectRow): WagerTransaction => {
  const currency = toText(row.currency, 'wager_transactions.currency');
  const referenceExternalTransactionId = toOptionalString(row.reference_external_transaction_id);
  const referenceTransactionId = toOptionalString(row.reference_transaction_id);
  const failureCode = toFailureCode(row.failure_code);
  const observedBalance = toOptionalMoney(row.observed_balance, row.wallet_currency_of_row);
  const nextAttemptAt = toOptionalDate(row.next_attempt_at);
  const processedAt = toOptionalDate(row.processed_at);
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    idempotencyKey: row.idempotency_key,
    externalTransactionId: row.external_transaction_id,
    playerId: row.player_id,
    walletId: row.wallet_id,
    roundId: toText(row.round_id, 'wager_transactions.round_id'),
    gameId: toText(row.game_id, 'wager_transactions.game_id'),
    kind: oneOf<WagerKind>(KINDS, row.kind, 'kind'),
    money: toMoney(row.amount, currency),
    payloadHash: row.payload_hash,
    createdAt: toDate(row.created_at),
    status: oneOf<WagerTransactionStatus>(STATUSES, row.status, 'status'),
    attempts: row.attempts,
    ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
    ...(referenceTransactionId === undefined ? {} : { referenceTransactionId }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(observedBalance === undefined ? {} : { observedBalance }),
    ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
    ...(processedAt === undefined ? {} : { processedAt }),
  });
};

export const WAGER_INSERT_COLUMNS =
  'id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, ' +
  'game_id, kind, status, amount, currency, reference_external_transaction_id, reference_transaction_id, ' +
  'failure_code, observed_balance, attempts, next_attempt_at, created_at, updated_at, processed_at';

export const wagerTransactionToInsertParams = (transaction: WagerTransaction): unknown[] => [
  transaction.id,
  transaction.providerId,
  transaction.externalTransactionId,
  transaction.idempotencyKey,
  transaction.payloadHash,
  transaction.walletId,
  transaction.playerId,
  transaction.roundId,
  transaction.gameId,
  transaction.kind,
  transaction.status,
  transaction.money.amount,
  transaction.money.currency,
  transaction.referenceExternalTransactionId ?? null,
  transaction.referenceTransactionId ?? null,
  transaction.failureCode ?? null,
  transaction.observedBalance?.amount ?? null,
  transaction.attempts,
  transaction.nextAttemptAt ?? null,
  transaction.createdAt,
  transaction.createdAt,
  transaction.processedAt ?? null,
];
