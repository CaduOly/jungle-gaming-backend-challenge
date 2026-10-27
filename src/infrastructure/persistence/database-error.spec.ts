import { describe, expect, it } from 'bun:test';
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

  it.each(['23505', '23503', '23514'])('leaves %s for the caller to interpret', (code) => {
    const original = sqlError(code);
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
