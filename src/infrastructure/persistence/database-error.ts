import { PermanentInfrastructureError } from '../error/permanent-infrastructure-error';
import { TransientInfrastructureError } from '../error/transient-infrastructure-error';

const LOCK_NOT_AVAILABLE = '55P03';
const DEADLOCK_DETECTED = '40P01';
const SERIALIZATION_FAILURE = '40001';
const RESTRICT_VIOLATION = '23001';
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

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Classifies a database failure. Transient: lock timeout, deadlock, serialization failures (40001/40003),
 * connection loss (class 08, 57P0x, driver messages), insufficient resources (class 53), statement timeout
 * (57014) and a pool acquire timeout. Anything not recognised (including 23505/23503/23514, which the
 * repositories or use cases interpret) is returned untouched.
 */
export const translateDatabaseError = (error: unknown): unknown => {
  if (error instanceof TransientInfrastructureError || error instanceof PermanentInfrastructureError) return error;
  const code = codeOf(error);
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
  if (code === RESTRICT_VIOLATION) {
    return new PermanentInfrastructureError(`Database integrity guard rejected the write: ${messageOf(error)}`, code, {
      cause: error,
    });
  }
  return error;
};
