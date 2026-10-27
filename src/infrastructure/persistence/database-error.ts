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
  '57P01',
  '57P02',
  '57P03',
]);
const TRANSIENT_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Classifies a database failure. Anything not recognised (including 23505/23503/23514, which the
 * repositories or use cases interpret) is returned untouched.
 */
export const translateDatabaseError = (error: unknown): unknown => {
  if (error instanceof TransientInfrastructureError || error instanceof PermanentInfrastructureError) return error;
  const code = codeOf(error);
  if (code === undefined) return error;
  if (TRANSIENT_SQL_STATES.has(code) || code.startsWith('08') || TRANSIENT_NETWORK_CODES.has(code)) {
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
