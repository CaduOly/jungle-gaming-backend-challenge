import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsObject, IsUUID, ValidateNested } from 'class-validator';
import { ValidationDetailMessage } from '../../shared/i18n/validation.detail-message';
import { MoneyRequestDto } from '../../shared/validation/money-request.dto';
import { withDetail } from '../../shared/validation/with-detail';

export class CreateWalletRequestDto {
  @ApiProperty({ format: 'uuid', example: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1' })
  @IsDefined(withDetail(ValidationDetailMessage.REQUIRED))
  @IsUUID('all', withDetail(ValidationDetailMessage.INVALID_UUID))
  playerId!: string;

  @ApiProperty({ type: MoneyRequestDto, description: 'A positive balance also writes the internal OPENING transaction.' })
  @IsDefined(withDetail(ValidationDetailMessage.REQUIRED))
  @IsObject(withDetail(ValidationDetailMessage.MUST_BE_OBJECT))
  @ValidateNested()
  @Type(() => MoneyRequestDto)
  initialBalance!: MoneyRequestDto;
}
