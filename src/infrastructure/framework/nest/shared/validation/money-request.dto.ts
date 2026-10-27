import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsString } from 'class-validator';
import { ValidationDetailMessage } from '../i18n/validation.detail-message';
import { CURRENCY_PATTERN, MONEY_AMOUNT_PATTERN } from '../swagger/schemas';
import { withDetail } from './with-detail';

/** Types only: the amount format is Money.from's rule (see toMoneyProps). */
export class MoneyRequestDto {
  @ApiProperty({ type: 'string', pattern: MONEY_AMOUNT_PATTERN, example: '25.00', description: 'Decimal string, never a number.' })
  @IsDefined(withDetail(ValidationDetailMessage.REQUIRED))
  @IsString(withDetail(ValidationDetailMessage.MUST_BE_STRING))
  amount!: string;

  @ApiProperty({ type: 'string', pattern: CURRENCY_PATTERN, example: 'BRL' })
  @IsDefined(withDetail(ValidationDetailMessage.REQUIRED))
  @IsString(withDetail(ValidationDetailMessage.MUST_BE_STRING))
  currency!: string;
}
