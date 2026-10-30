import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsNotIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ValidationDetailMessage } from '../../shared/i18n/validation.detail-message';
import { MoneyRequestDto } from '../../shared/validation/money-request.dto';
import { withDetail } from '../../shared/validation/with-detail';

export const SUBMITTABLE_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
const MAX_TEXT = 255;

const Text = (): PropertyDecorator => {
  const decorators = [
    IsDefined(withDetail(ValidationDetailMessage.REQUIRED)),
    IsString(withDetail(ValidationDetailMessage.MUST_BE_STRING)),
    MinLength(1, withDetail(ValidationDetailMessage.BLANK)),
    MaxLength(MAX_TEXT, withDetail(ValidationDetailMessage.TOO_LONG)),
  ];
  return (target, key) => decorators.forEach((decorator) => decorator(target, key));
};

const Uuid = (): PropertyDecorator => {
  const decorators = [
    IsDefined(withDetail(ValidationDetailMessage.REQUIRED)),
    IsUUID('all', withDetail(ValidationDetailMessage.INVALID_UUID)),
  ];
  return (target, key) => decorators.forEach((decorator) => decorator(target, key));
};

export class SubmitWagerTransactionRequestDto {
  @ApiProperty({ example: 'provider-a', maxLength: MAX_TEXT, description: 'Must be the authenticated provider.' })
  @Text()
  providerId!: string;

  @ApiProperty({ example: 'transaction-123', maxLength: MAX_TEXT })
  @Text()
  externalTransactionId!: string;

  @ApiProperty({ format: 'uuid', example: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1' })
  @Uuid()
  playerId!: string;

  @ApiProperty({ format: 'uuid', example: '0192f291-27dd-7d3f-8071-5f8685deef37' })
  @Uuid()
  walletId!: string;

  @ApiProperty({ example: 'round-987', maxLength: MAX_TEXT })
  @Text()
  roundId!: string;

  @ApiProperty({ example: 'fortune-chimp', maxLength: MAX_TEXT })
  @Text()
  gameId!: string;

  @ApiProperty({ enum: SUBMITTABLE_KINDS, example: 'BET', description: 'OPENING is internal and rejected with 400.' })
  // O class-validator roda as constraints de baixo para cima, então OPENING tem que ter detail próprio e não INVALID_KIND.
  @IsDefined(withDetail(ValidationDetailMessage.REQUIRED))
  @IsIn(SUBMITTABLE_KINDS, withDetail(ValidationDetailMessage.INVALID_KIND))
  @IsNotIn(['OPENING'], withDetail(ValidationDetailMessage.KIND_NOT_SUBMITTABLE))
  kind!: string;

  @ApiProperty({ type: MoneyRequestDto })
  @IsDefined(withDetail(ValidationDetailMessage.REQUIRED))
  @IsObject(withDetail(ValidationDetailMessage.MUST_BE_OBJECT))
  @ValidateNested()
  @Type(() => MoneyRequestDto)
  money!: MoneyRequestDto;

  @ApiPropertyOptional({
    example: 'transaction-122',
    maxLength: MAX_TEXT,
    description: 'Provider id of the referenced transaction (REFUND/ROLLBACK require it; WIN/LOSS may carry it).',
  })
  @IsOptional()
  @IsString(withDetail(ValidationDetailMessage.MUST_BE_STRING))
  @MinLength(1, withDetail(ValidationDetailMessage.BLANK))
  @MaxLength(MAX_TEXT, withDetail(ValidationDetailMessage.TOO_LONG))
  referenceExternalTransactionId?: string;
}
