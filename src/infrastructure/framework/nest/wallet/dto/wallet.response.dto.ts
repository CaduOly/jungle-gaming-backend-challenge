import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../shared/swagger/schemas';

export class WalletDto {
  @ApiProperty({ format: 'uuid', example: '0192f291-27dd-7d3f-8071-5f8685deef37' })
  id!: string;

  @ApiProperty({ format: 'uuid', example: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1' })
  playerId!: string;

  @ApiProperty({ type: MoneyDto })
  balance!: MoneyDto;

  @ApiProperty({ example: 1 })
  version!: number;
}

export class LedgerEntryDto {
  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ enum: ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'], example: 'BET' })
  entryType!: string;

  @ApiProperty({ enum: ['CREDIT', 'DEBIT'], example: 'DEBIT' })
  direction!: string;

  @ApiProperty({ type: MoneyDto })
  amount!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  balanceBefore!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  balanceAfter!: MoneyDto;

  @ApiProperty({ example: 2 })
  walletVersion!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class LedgerPageDto {
  @ApiProperty({ format: 'uuid' })
  walletId!: string;

  @ApiProperty({ type: [LedgerEntryDto] })
  entries!: LedgerEntryDto[];

  @ApiProperty({ type: 'string', nullable: true, description: 'Opaque; null on the last page.', example: 'c2VxOjQy' })
  nextCursor!: string | null;
}

export class ReconciliationDto {
  @ApiProperty({ format: 'uuid' })
  walletId!: string;

  @ApiProperty({ type: MoneyDto })
  storedBalance!: MoneyDto;

  @ApiProperty({ type: MoneyDto, nullable: true })
  calculatedBalance!: MoneyDto | null;

  @ApiProperty({ type: MoneyDto, nullable: true })
  difference!: MoneyDto | null;

  @ApiProperty({ description: 'False is logged and counted, never corrected.' })
  consistent!: boolean;

  @ApiProperty({ example: 42 })
  checkedEntries!: number;
}
