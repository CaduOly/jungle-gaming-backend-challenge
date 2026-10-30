import { InputRule } from '../error/input-rule';
import { InvalidRequestError } from '../error/invalid-request-error';

export const MAX_TEXT_LENGTH = 255;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Espaço nas pontas é rejeitado, não é feito trim, senão " tx-1" e "tx-1" teriam hash e registro diferentes.
 * Byte NUL também é rejeitado, já que o text do PostgreSQL não aceita, então só ia falhar depois, na escrita.
 */
export const requireText = (field: string, value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT_LENGTH) {
    throw new InvalidRequestError(field, `must be a non-blank string of at most ${MAX_TEXT_LENGTH} characters`, InputRule.BLANK);
  }
  if (value.trim() !== value) throw new InvalidRequestError(field, 'must not start or end with whitespace', InputRule.SURROUNDING_WHITESPACE);
  if (value.includes('\u0000')) throw new InvalidRequestError(field, 'must not contain a NUL character', InputRule.NUL_CHARACTER);
  return value;
};

/**
 * Os ids de wallet e player são colunas uuid, então qualquer outra coisa é recusada aqui, antes de chegar no schema.
 * O resultado sai em minúscula, que é como o PostgreSQL devolve, então o mesmo id em outra caixa gera o mesmo hash,
 * compara e grava igual, seja qual for o canal (HTTP ou SQS).
 */
export const requireUuid = (field: string, value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new InvalidRequestError(field, 'must be a UUID', InputRule.INVALID_UUID);
  return value.toLowerCase();
};
