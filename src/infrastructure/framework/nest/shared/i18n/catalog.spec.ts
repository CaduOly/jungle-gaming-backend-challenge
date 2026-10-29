import { describe, expect, it } from 'bun:test';
import { FailureCode } from '../../../../../business/shared/error/failure-code';
import { InputRule } from '../../../../../business/shared/error/input-rule';
import { allDetailMessages, DETAIL_MESSAGE_CATALOGS, detailForFailureCode, detailForInputRule, findDetailMessage } from './catalog';

describe('detail message catalog', () => {
  it('has an entry for every FailureCode, whose code is the FailureCode itself', () => {
    for (const code of Object.values(FailureCode)) {
      expect({ code, entry: findDetailMessage(code)?.code }).toEqual({ code, entry: code });
      expect(detailForFailureCode(code).code).toBe(code);
    }
  });

  it('already maps BALANCE_LIMIT_EXCEEDED, the balance overflow rejection', () => {
    expect(findDetailMessage('BALANCE_LIMIT_EXCEEDED')).toEqual({
      code: 'BALANCE_LIMIT_EXCEEDED',
      message: 'WAGERING.ERROR.BALANCE_LIMIT_EXCEEDED',
      type: 'error',
    });
  });

  it('has a VALIDATION entry named after every InputRule, and INVALID_REQUEST when no rule is named', () => {
    for (const rule of Object.values(InputRule)) {
      expect(detailForInputRule(rule)).toEqual(findDetailMessage(rule)!);
      expect(detailForInputRule(rule).message).toBe(`VALIDATION.ERROR.${rule}`);
    }
    expect(detailForInputRule(undefined).code).toBe('INVALID_REQUEST');
  });

  it('never repeats a code nor a message key', () => {
    const entries = allDetailMessages();
    expect(new Set(entries.map((entry) => entry.code)).size).toBe(entries.length);
    expect(new Set(entries.map((entry) => entry.message)).size).toBe(entries.length);
  });

  it('keys every message as <NAMESPACE>.<ERROR|WARNING>.<CODE> under its own namespace', () => {
    for (const [namespace, catalog] of Object.entries(DETAIL_MESSAGE_CATALOGS)) {
      for (const [field, entry] of Object.entries(catalog)) {
        expect(entry.code).toBe(field);
        expect(entry.message).toBe(`${namespace}.${entry.type === 'warning' ? 'WARNING' : 'ERROR'}.${entry.code}`);
      }
    }
  });
});
