import { BusinessRuleError } from '../../../business/shared/error/business-rule-error';
import { DomainError } from '../../../business/shared/error/domain-error';
import { InvalidRequestError } from '../../../business/shared/error/invalid-request-error';
import { IdempotencyConflictError } from '../../../business/wagering/error/idempotency-conflict-error';
import { PermanentInfrastructureError } from '../../error/permanent-infrastructure-error';
import { TransientInfrastructureError } from '../../error/transient-infrastructure-error';

const LOCK_NOT_AVAILABLE = '55P03';
const DEADLOCK_DETECTED = '40P01';

export type LockConflictType = 'timeout' | 'deadlock';

export type ErrorClass =
  | 'invalid_request'
  | 'business_rule'
  | 'idempotency_conflict'
  | 'domain'
  | 'lock_timeout'
  | 'deadlock'
  | 'transient'
  | 'permanent'
  | 'unexpected';

const sqlStateOf = (error: unknown): string | undefined =>
  error instanceof TransientInfrastructureError || error instanceof PermanentInfrastructureError
    ? error.sqlState
    : undefined;

export const lockConflictOf = (error: unknown): LockConflictType | undefined => {
  const sqlState = sqlStateOf(error);
  if (sqlState === LOCK_NOT_AVAILABLE) return 'timeout';
  if (sqlState === DEADLOCK_DETECTED) return 'deadlock';
  return undefined;
};

/** A bounded label for a failure: never the message, which may carry ids or values. */
export const classifyError = (error: unknown): ErrorClass => {
  if (error instanceof InvalidRequestError) return 'invalid_request';
  if (error instanceof BusinessRuleError) return 'business_rule';
  if (error instanceof IdempotencyConflictError) return 'idempotency_conflict';
  if (error instanceof DomainError) return 'domain';
  const lockConflict = lockConflictOf(error);
  if (lockConflict === 'timeout') return 'lock_timeout';
  if (lockConflict === 'deadlock') return 'deadlock';
  if (error instanceof TransientInfrastructureError) return 'transient';
  if (error instanceof PermanentInfrastructureError) return 'permanent';
  return 'unexpected';
};

const EXPECTED: ReadonlySet<ErrorClass> = new Set(['invalid_request', 'business_rule', 'idempotency_conflict', 'domain']);

/** A domain answer (400, 404, 409, 422) is the service working as designed; the rest is an incident. */
export const isExpectedError = (errorClass: ErrorClass): boolean => EXPECTED.has(errorClass);

/**
 * What a log line may say about a failure. A domain error is described by its name and codes only: its message
 * can carry values. An infrastructure error keeps its message, which holds no payload.
 */
export const describeError = (error: unknown): Record<string, unknown> => {
  const errorClass = classifyError(error);
  const fields: Record<string, unknown> = { errorClass, error: error instanceof Error ? error.name : typeof error };
  if (error !== null && typeof error === 'object') {
    if ('failureCode' in error && typeof error.failureCode === 'string') fields.failureCode = error.failureCode;
    if (error instanceof InvalidRequestError) {
      fields.field = error.field;
      if (error.rule !== undefined) fields.rule = error.rule;
    }
  }
  const sqlState = sqlStateOf(error);
  if (sqlState !== undefined) fields.sqlState = sqlState;
  if (!(error instanceof DomainError) && error instanceof Error) {
    fields.errorMessage = error.message;
    if (errorClass === 'unexpected' && error.stack !== undefined) fields.stack = error.stack;
  }
  return fields;
};
