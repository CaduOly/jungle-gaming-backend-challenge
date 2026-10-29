import { UniqueConstraintViolationError } from '../../business/shared/error/unique-constraint-violation-error';
import { PermanentInfrastructureError } from '../error/permanent-infrastructure-error';
import { TransientInfrastructureError } from '../error/transient-infrastructure-error';

const LOCK_NOT_AVAILABLE = '55P03';
const DEADLOCK_DETECTED = '40P01';
const SERIALIZATION_FAILURE = '40001';
const RESTRICT_VIOLATION = '23001';
const UNIQUE_VIOLATION = '23505';
/** Foreign key, check and not-null: the schema caught a write the application should never have built. */
const SCHEMA_GUARD_VIOLATIONS = new Set(['23503', '23514', '23502']);
/**
 * The same statement with the same input fails the same way every time: 22P02 (text that is not a valid value of
 * the column type, e.g. a non-uuid id), 08P01 (protocol violation, e.g. a NUL byte in a text parameter; class 08
 * but not a lost connection) and 25006 (a write inside a read-only snapshot).
 */
const PERMANENT_SQL_STATES = new Set(['22P02', '08P01', '25006']);
const TRANSIENT_SQL_STATES = new Set([
  LOCK_NOT_AVAILABLE,
  DEADLOCK_DETECTED,
  SERIALIZATION_FAILURE,
  '40003',
  '57P01',
  '57P02',
  '57P03',
  // statement_timeout / query canceled: the statement may well succeed on a retry once the load drops.
  '57014',
]);
/** pg reports a dropped connection or an exhausted pool with a plain Error, no SQLSTATE. */
const TRANSIENT_DRIVER_MESSAGES = [
  /connection terminated/i,
  /terminating connection/i,
  /is not queryable/i,
  /timeout exceeded when trying to connect/i,
  /connection (?:error|ended)/i,
  /server closed the connection unexpectedly/i,
];
const TRANSIENT_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
};

const constraintOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('constraint' in error)) return undefined;
  return typeof error.constraint === 'string' ? error.constraint : undefined;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Classifies a database failure. Transient: lock timeout, deadlock, serialization failures (40001/40003),
 * connection loss (class 08 except 08P01, 57P0x, driver messages), insufficient resources (class 53), statement timeout
 * (57014) and a pool acquire timeout. A unique violation (23505) lost a race against a concurrent commit and
 * becomes UniqueConstraintViolationError with the constraint name, which the use cases interpret. Trigger
 * guards (23001), foreign keys, checks and not-null (23503/23514/23502) are permanent: a bug, never a retry, and so
 * are 22P02, 08P01 and 25006.
 * Anything else is returned untouched.
 */
export const translateDatabaseError = (error: unknown): unknown => {
  if (
    error instanceof TransientInfrastructureError ||
    error instanceof PermanentInfrastructureError ||
    error instanceof UniqueConstraintViolationError
  ) {
    return error;
  }
  const code = codeOf(error);
  if (code !== undefined && PERMANENT_SQL_STATES.has(code)) {
    return new PermanentInfrastructureError(`Database refused the statement (${code}): ${messageOf(error)}`, code, {
      cause: error,
    });
  }
  if (code === undefined) {
    if (!(error instanceof Error) || !TRANSIENT_DRIVER_MESSAGES.some((pattern) => pattern.test(error.message))) {
      return error;
    }
    return new TransientInfrastructureError(`Transient database failure: ${error.message}`, undefined, { cause: error });
  }
  if (
    TRANSIENT_SQL_STATES.has(code) ||
    code.startsWith('08') ||
    code.startsWith('53') ||
    TRANSIENT_NETWORK_CODES.has(code)
  ) {
    return new TransientInfrastructureError(`Transient database failure (${code}): ${messageOf(error)}`, code, {
      cause: error,
    });
  }
  if (code === UNIQUE_VIOLATION) {
    return new UniqueConstraintViolationError(constraintOf(error) ?? 'unknown', { cause: error });
  }
  if (code === RESTRICT_VIOLATION || SCHEMA_GUARD_VIOLATIONS.has(code)) {
    const constraint = constraintOf(error);
    const detail = constraint === undefined ? '' : ` (${constraint})`;
    return new PermanentInfrastructureError(
      `Database integrity guard rejected the write${detail}: ${messageOf(error)}`,
      code,
      { cause: error },
    );
  }
  return error;
};
