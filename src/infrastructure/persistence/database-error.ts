import { UniqueConstraintViolationError } from '../../business/shared/error/unique-constraint-violation-error';
import { PermanentInfrastructureError } from '../error/permanent-infrastructure-error';
import { TransientInfrastructureError } from '../error/transient-infrastructure-error';

const LOCK_NOT_AVAILABLE = '55P03';
const DEADLOCK_DETECTED = '40P01';
const SERIALIZATION_FAILURE = '40001';
const RESTRICT_VIOLATION = '23001';
const UNIQUE_VIOLATION = '23505';
/** Foreign key, check e not-null: o schema pegou uma escrita que a aplicação nunca deveria ter montado. */
const SCHEMA_GUARD_VIOLATIONS = new Set(['23503', '23514', '23502']);
/**
 * O mesmo statement com o mesmo input falha do mesmo jeito toda vez: 22P02 (texto que não é valor válido do tipo
 * da coluna, ex. um id que não é uuid), 08P01 (violação de protocolo, ex. um byte NUL num parâmetro texto; é classe
 * 08 mas não é conexão perdida) e 25006 (escrita dentro de um snapshot read-only).
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
  // statement_timeout / query canceled: o statement pode muito bem passar num retry quando a carga baixar.
  '57014',
]);
/** O pg reporta conexão caída ou pool esgotado com um Error simples, sem SQLSTATE. */
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
 * Classifica uma falha do banco. Transiente: lock timeout, deadlock, falha de serialização (40001/40003), conexão
 * perdida (classe 08 menos 08P01, 57P0x, mensagens do driver), recurso insuficiente (classe 53), statement timeout
 * (57014) e timeout de acquire do pool. Unique violation (23505) é uma corrida perdida contra um commit concorrente
 * e vira UniqueConstraintViolationError com o nome da constraint, que os use cases interpretam. Guardas de trigger
 * (23001), foreign keys, checks e not-null (23503/23514/23502) são permanentes, é bug e nunca retry, e o mesmo vale
 * para 22P02, 08P01 e 25006.
 * Qualquer outra coisa volta sem mexer.
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
