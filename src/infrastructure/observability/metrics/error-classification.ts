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

/** Label com cardinalidade limitada para uma falha: nunca a mensagem, que pode carregar ids ou valores. */
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

/** Resposta de domínio (400, 404, 409, 422) é o serviço funcionando como foi desenhado, o resto é incidente. */
export const isExpectedError = (errorClass: ErrorClass): boolean => EXPECTED.has(errorClass);

/**
 * O que uma linha de log pode dizer sobre uma falha. Erro de domínio é descrito só pelo nome e pelos códigos, já que
 * a mensagem pode carregar valores. Erro de infraestrutura mantém a mensagem, que não tem payload.
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
