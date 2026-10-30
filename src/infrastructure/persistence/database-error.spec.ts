import { describe, expect, it } from 'bun:test';
import { UniqueConstraintViolationError } from '../../business/shared/error/unique-constraint-violation-error';
import { PermanentInfrastructureError } from '../error/permanent-infrastructure-error';
import { TransientInfrastructureError } from '../error/transient-infrastructure-error';
import { translateDatabaseError } from './database-error';

const sqlError = (code: string) => Object.assign(new Error(`boom ${code}`), { code });

describe('translateDatabaseError', () => {
  it.each(['55P03', '40P01', '40001', '40003', '57P01', '57014', '08006', '53000', '53100', '53200', '53300', 'ECONNREFUSED'])('maps %s to a transient error', (code) => {
    const original = sqlError(code);
    const translated = translateDatabaseError(original);

    expect(translated).toBeInstanceOf(TransientInfrastructureError);
    expect((translated as TransientInfrastructureError).sqlState).toBe(code);
    expect((translated as Error).cause).toBe(original);
  });

  it.each([
    'Connection terminated unexpectedly',
    'Connection terminated',
    'Client has encountered a connection error and is not queryable',
    'Client was closed and is not queryable',
    'timeout exceeded when trying to connect',
    'terminating connection due to administrator command',
  ])('maps the code-less driver error %p to a transient error', (message) => {
    const original = new Error(message);
    const translated = translateDatabaseError(original);
    expect(translated).toBeInstanceOf(TransientInfrastructureError);
    expect((translated as TransientInfrastructureError).sqlState).toBeUndefined();
    expect((translated as Error).cause).toBe(original);
  });

  it('maps a trigger guard (23001) to a permanent error', () => {
    const translated = translateDatabaseError(sqlError('23001'));
    expect(translated).toBeInstanceOf(PermanentInfrastructureError);
    expect((translated as PermanentInfrastructureError).sqlState).toBe('23001');
  });

  it('maps a unique violation (23505) to UniqueConstraintViolationError carrying the constraint name', () => {
    const original = Object.assign(sqlError('23505'), { constraint: 'wager_transactions_provider_idempotency_key_unique' });
    const translated = translateDatabaseError(original);
    expect(translated).toBeInstanceOf(UniqueConstraintViolationError);
    expect((translated as UniqueConstraintViolationError).constraint).toBe('wager_transactions_provider_idempotency_key_unique');
    expect((translated as Error).cause).toBe(original);
  });

  it('keeps a unique violation without a constraint name recognisable', () => {
    const translated = translateDatabaseError(sqlError('23505'));
    expect((translated as UniqueConstraintViolationError).constraint).toBe('unknown');
  });

  it.each(['23503', '23514', '23502'])('maps the schema guard %s to a permanent error naming the constraint', (code) => {
    const translated = translateDatabaseError(Object.assign(sqlError(code), { constraint: 'some_constraint' }));
    expect(translated).toBeInstanceOf(PermanentInfrastructureError);
    expect((translated as PermanentInfrastructureError).sqlState).toBe(code);
    expect((translated as Error).message).toContain('some_constraint');
  });

  it('does not wrap an already translated unique violation twice', () => {
    const translated = translateDatabaseError(sqlError('23505'));
    expect(translateDatabaseError(translated)).toBe(translated);
  });

  it.each([
    ['22P02', 'invalid text representation (a non-uuid in a uuid column)'],
    ['08P01', 'protocol violation (a NUL byte in a text parameter)'],
    ['25006', 'read-only sql transaction (a write inside a snapshot)'],
  ])('maps %s, %s, to a permanent error: retrying the same input never helps', (code) => {
    const original = sqlError(code);
    const translated = translateDatabaseError(original);
    expect(translated).toBeInstanceOf(PermanentInfrastructureError);
    expect((translated as PermanentInfrastructureError).sqlState).toBe(code);
    expect((translated as Error).cause).toBe(original);
  });

  it('leaves other SQL states (e.g. 42601) for the caller to interpret', () => {
    const original = sqlError('42601');
    expect(translateDatabaseError(original)).toBe(original);
  });

  it('leaves errors without a code (e.g. domain errors) untouched', () => {
    const original = new Error('business');
    expect(translateDatabaseError(original)).toBe(original);
    expect(translateDatabaseError('text')).toBe('text');
  });

  it('does not wrap an already classified error twice', () => {
    const transient = translateDatabaseError(sqlError('40P01'));
    expect(translateDatabaseError(transient)).toBe(transient);
  });
});
