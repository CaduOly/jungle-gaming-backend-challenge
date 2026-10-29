import { describe, expect, it } from 'bun:test';
import 'reflect-metadata';
import { getMetadataStorage } from 'class-validator';
import { SubmitWagerTransactionRequestDto } from '../../wagering/dto/submit-wager-transaction.request.dto';
import { CreateWalletRequestDto } from '../../wallet/dto/create-wallet.request.dto';
import { findDetailMessage } from '../i18n/catalog';
import { MoneyRequestDto } from './money-request.dto';

const REQUEST_DTOS = [CreateWalletRequestDto, SubmitWagerTransactionRequestDto, MoneyRequestDto];
/** Structural markers that never produce an error of their own. */
const SILENT = new Set(['conditionalValidation', 'nestedValidation']);

describe('validation messages', () => {
  it('gives every DTO rule a context that is a catalog entry', () => {
    for (const dto of REQUEST_DTOS) {
      const rules = getMetadataStorage().getTargetValidationMetadatas(dto, '', false, false);
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        if (SILENT.has(rule.type)) continue;
        const where = `${dto.name}.${rule.propertyName} (${rule.name ?? rule.type})`;
        const context = rule.context as { code?: string } | undefined;
        expect({ where, entry: context?.code === undefined ? undefined : findDetailMessage(context.code) }).toEqual({
          where,
          entry: context as never,
        });
      }
    }
  });
});
