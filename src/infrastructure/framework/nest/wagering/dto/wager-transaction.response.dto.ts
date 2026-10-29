import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../shared/swagger/schemas';

export class WagerOutcomeDto {
  @ApiProperty({ format: 'uuid', example: '0192f298-345e-7e38-af88-e43f851a819d' })
  transactionId!: string;

  @ApiProperty({ enum: ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE'], example: 'PROCESSED' })
  status!: string;

  @ApiProperty({ type: MoneyDto, nullable: true, description: 'Balance observed at the decision.' })
  balance!: MoneyDto | null;

  @ApiProperty({ description: 'True when this answer is the replay of an earlier identical request.' })
  idempotentReplay!: boolean;
}

export class WagerTransactionDto {
  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ example: 'provider-a' })
  providerId!: string;

  @ApiProperty({ example: 'transaction-123' })
  externalTransactionId!: string;

  @ApiProperty({ format: 'uuid' })
  walletId!: string;

  @ApiProperty({ format: 'uuid' })
  playerId!: string;

  @ApiProperty({ example: 'round-987' })
  roundId!: string;

  @ApiProperty({ example: 'fortune-chimp' })
  gameId!: string;

  @ApiProperty({ enum: ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] })
  kind!: string;

  @ApiProperty({ type: MoneyDto })
  money!: MoneyDto;

  @ApiProperty({ enum: ['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'] })
  status!: string;

  @ApiProperty({ type: 'string', nullable: true, example: null })
  failureCode!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  referenceExternalTransactionId!: string | null;

  @ApiProperty({ type: 'string', nullable: true, format: 'uuid' })
  referenceTransactionId!: string | null;

  @ApiProperty({ type: MoneyDto, nullable: true })
  balance!: MoneyDto | null;

  @ApiProperty({ example: 0 })
  attempts!: number;

  @ApiProperty({ type: 'string', nullable: true, format: 'date-time' })
  nextAttemptAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: 'string', nullable: true, format: 'date-time' })
  processedAt!: string | null;
}
