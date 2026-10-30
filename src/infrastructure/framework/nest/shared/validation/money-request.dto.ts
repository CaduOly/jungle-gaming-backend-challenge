import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsString, ValidateBy } from 'class-validator';
import { Money } from '../../../../../business/shared/value-object/money';
import { ValidationDetailMessage } from '../i18n/validation.detail-message';
import { CURRENCY_PATTERN, MONEY_AMOUNT_PATTERN } from '../swagger/schemas';
import { withDetail } from './with-detail';

/**
 * Aplicados nessa ordem, e o class-validator roda na ordem em que foram aplicados. Regra custom precisa de mensagem
 * default não vazia, já que o class-validator só anexa o context (a entrada do catálogo) quando ela é truthy.
 */
const all = (...decorators: PropertyDecorator[]): PropertyDecorator => (target, key) =>
  decorators.forEach((decorator) => decorator(target, key));

/**
 * As regras de formato são as do próprio Money (isValidAmount / isValidCurrency), checadas aqui campo a campo para
 * que uma request com amount e currency inválidos fique sabendo dos dois, junto com todo outro campo inválido.
 */
export class MoneyRequestDto {
  @ApiProperty({ type: 'string', pattern: MONEY_AMOUNT_PATTERN, example: '25.00', description: 'Decimal string, never a number.' })
  @all(
    IsDefined(withDetail(ValidationDetailMessage.REQUIRED)),
    IsString(withDetail(ValidationDetailMessage.MUST_BE_STRING)),
    ValidateBy(
      { name: 'isMoneyAmount', validator: { validate: (value: unknown) => Money.isValidAmount(value), defaultMessage: () => 'amount' } },
      withDetail(ValidationDetailMessage.INVALID_MONEY_AMOUNT),
    ),
  )
  amount!: string;

  @ApiProperty({ type: 'string', pattern: CURRENCY_PATTERN, example: 'BRL' })
  @all(
    IsDefined(withDetail(ValidationDetailMessage.REQUIRED)),
    IsString(withDetail(ValidationDetailMessage.MUST_BE_STRING)),
    ValidateBy(
      { name: 'isCurrency', validator: { validate: (value: unknown) => Money.isValidCurrency(value), defaultMessage: () => 'currency' } },
      withDetail(ValidationDetailMessage.INVALID_CURRENCY),
    ),
  )
  currency!: string;
}
