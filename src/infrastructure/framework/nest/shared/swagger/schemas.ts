import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const MONEY_AMOUNT_PATTERN = '^(0|[1-9]\\d{0,17})\\.\\d{2}$';
export const CURRENCY_PATTERN = '^[A-Z]{3}$';

export class DetailMessageDto {
  @ApiProperty({ example: 'INSUFFICIENT_FUNDS', description: 'Stable code clients branch on (a FailureCode for business rejections).' })
  code!: string;

  @ApiProperty({ example: 'WAGERING.ERROR.INSUFFICIENT_FUNDS', description: 'i18n key; the front end translates it.' })
  message!: string;

  @ApiPropertyOptional({ example: 'money.amount', description: 'Dotted path of the offending field.' })
  field?: string;

  @ApiProperty({ enum: ['error', 'warning'] })
  type!: 'error' | 'warning';
}

/** The envelope every business endpoint answers with; `data` is narrowed per endpoint by envelopeSchema(). */
export class ApiResponseEnvelopeDto {
  @ApiProperty({ example: 200, description: 'Same number as the HTTP status.' })
  code!: number;

  @ApiProperty({ example: 'SUCCESS', description: 'Name of the status in the Code catalog.' })
  message!: string;

  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  data!: unknown;

  @ApiProperty({ example: 1761570000000, description: 'Epoch milliseconds.' })
  timestamp!: number;

  @ApiProperty({ type: [DetailMessageDto] })
  detailsMessage!: DetailMessageDto[];
}

export class MoneyDto {
  @ApiProperty({ type: 'string', pattern: MONEY_AMOUNT_PATTERN, example: '25.00', description: 'Decimal string, never a number.' })
  amount!: string;

  @ApiProperty({ type: 'string', pattern: CURRENCY_PATTERN, example: 'BRL' })
  currency!: string;
}
