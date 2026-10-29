import type { WagerSubmission } from '../../business/wagering/use-case/process-wager-transaction/process-wager-transaction.dto';
import { InvalidMessageError } from '../messaging/sqs/invalid-message-error';
import { DeadLetterReason } from '../messaging/sqs/message-handler.port';

export const WAGER_COMMAND_TYPE = 'WagerTransactionRequested';

/** CHALLENGE.md §10: one wager submission sent by a provider through the commands queue. */
export interface WagerCommand {
  readonly messageId: string;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
  readonly submission: WagerSubmission;
}

const ENVELOPE_KEYS = new Set(['messageId', 'type', 'occurredAt', 'data']);
const DATA_KEYS = new Set([
  'providerId',
  'externalTransactionId',
  'idempotencyKey',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
  'referenceExternalTransactionId',
]);
const MONEY_KEYS = new Set(['amount', 'currency']);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const invalid = (detail: string): InvalidMessageError => new InvalidMessageError(DeadLetterReason.INVALID_SCHEMA, detail);

const objectAt = (value: unknown, path: string, allowed: ReadonlySet<string>): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${path} must be an object`);
  const unknownKey = Object.keys(value).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) throw invalid(`${path}.${unknownKey} is not part of the contract`);
  return value as Record<string, unknown>;
};

const stringAt = (record: Record<string, unknown>, key: string, path: string): string => {
  const value = record[key];
  if (typeof value !== 'string') throw invalid(`${path}.${key} must be a string`);
  return value;
};

/**
 * Checks the shape of the message (types, required and unknown keys) and nothing more: the content (UUIDs, amounts,
 * kinds, lengths) is the use case's job, so HTTP and SQS reject the same things. Shape errors are permanent
 * (invalid_schema) and OPENING, a kind only the system may write, is a contract violation.
 */
export const parseWagerCommand = (body: unknown): WagerCommand => {
  const envelope = objectAt(body, '$', ENVELOPE_KEYS);
  const messageId = stringAt(envelope, 'messageId', '$');
  if (messageId.trim() === '') throw invalid('$.messageId must not be blank');
  if (envelope.type !== WAGER_COMMAND_TYPE) throw invalid(`$.type must be ${WAGER_COMMAND_TYPE}`);
  const occurredAt = stringAt(envelope, 'occurredAt', '$');
  if (!ISO_INSTANT.test(occurredAt) || Number.isNaN(Date.parse(occurredAt))) {
    throw invalid('$.occurredAt must be an ISO-8601 instant');
  }
  const data = objectAt(envelope.data, '$.data', DATA_KEYS);
  const money = objectAt(data.money, '$.data.money', MONEY_KEYS);
  const reference = data.referenceExternalTransactionId;
  if (reference !== undefined && reference !== null && typeof reference !== 'string') {
    throw invalid('$.data.referenceExternalTransactionId must be a string or null');
  }
  const kind = stringAt(data, 'kind', '$.data');
  if (kind === 'OPENING') {
    throw new InvalidMessageError(DeadLetterReason.CONTRACT_VIOLATION, 'OPENING is internal and cannot be submitted');
  }
  return {
    messageId,
    occurredAt,
    idempotencyKey: stringAt(data, 'idempotencyKey', '$.data'),
    submission: {
      providerId: stringAt(data, 'providerId', '$.data'),
      externalTransactionId: stringAt(data, 'externalTransactionId', '$.data'),
      playerId: stringAt(data, 'playerId', '$.data'),
      walletId: stringAt(data, 'walletId', '$.data'),
      roundId: stringAt(data, 'roundId', '$.data'),
      gameId: stringAt(data, 'gameId', '$.data'),
      kind,
      money: { amount: stringAt(money, 'amount', '$.data.money'), currency: stringAt(money, 'currency', '$.data.money') },
      ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
    },
  };
};
