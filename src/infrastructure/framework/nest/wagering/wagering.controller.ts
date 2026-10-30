import { Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedProvider } from '../../../../business/shared/port/provider-identity.port';
import { ProviderIdentityMismatchError } from '../../../../business/wagering/error/provider-identity-mismatch-error';
import { WagerTransactionNotFoundError } from '../../../../business/wagering/error/wager-transaction-not-found-error';
import type { IUseCase } from '../../../../business/shared/use-case';
import type {
  GetWagerTransactionInput,
  WagerTransactionView,
} from '../../../../business/wagering/use-case/get-wager-transaction/get-wager-transaction';
import type {
  ProcessWagerTransactionInput,
  ProcessWagerTransactionOutput,
} from '../../../../business/wagering/use-case/process-wager-transaction/process-wager-transaction.dto';
import { CurrentProvider } from '../shared/auth/current-provider.decorator';
import { GET_WAGER_TRANSACTION, PROCESS_WAGER_TRANSACTION } from '../shared/di/tokens';
import { detail } from '../shared/envelope/api-response';
import { HttpResult } from '../shared/envelope/http-result';
import { JsonContentTypeGuard } from '../shared/http/json-content-type.guard';
import { detailForFailureCode } from '../shared/i18n/catalog';
import { InfraDetailMessage } from '../shared/i18n/infra.detail-message';
import { CorrelationId } from '../shared/observability/correlation-id.decorator';
import { WageringDetailMessage } from '../shared/i18n/wagering.detail-message';
import { BodyWithIdempotencyKey, type KeyedBody } from '../shared/validation/keyed-body';
import { TextParamPipe, UuidParamPipe } from '../shared/validation/params';
import { SubmitWagerTransactionRequestDto } from './dto/submit-wager-transaction.request.dto';
import {
  ApiGetProviderTransactionResponses,
  ApiGetWagerTransactionResponses,
  ApiSubmitWagerTransactionResponses,
} from './wagering.swagger';

/** PROCESSED → 200, PENDING_REFERENCE → 202, REJECTED → 422, um replay responde exatamente como o original. */
const toResult = (output: ProcessWagerTransactionOutput) => {
  const data = {
    transactionId: output.transactionId,
    status: output.status,
    balance: output.balance,
    idempotentReplay: output.idempotentReplay,
  };
  switch (output.status) {
    case 'PROCESSED':
      return HttpResult.ok(data);
    case 'PENDING_REFERENCE':
      return new HttpResult(202, data, [detail(WageringDetailMessage.REFERENCE_PENDING)]);
    case 'REJECTED':
      return new HttpResult(422, data, output.failureCode === null ? [] : [detail(detailForFailureCode(output.failureCode))]);
    default:
      return new HttpResult(500, data, [detail(InfraDetailMessage.INTERNAL_ERROR)]);
  }
};

const ensureOwner = (actor: AuthenticatedProvider, providerId: string): void => {
  if (actor.providerId !== providerId) throw new ProviderIdentityMismatchError(actor.providerId, providerId);
};

@ApiTags('wagering')
@ApiBearerAuth()
@Controller()
export class WageringController {
  constructor(
    @Inject(PROCESS_WAGER_TRANSACTION)
    private readonly processTransaction: IUseCase<ProcessWagerTransactionInput, ProcessWagerTransactionOutput>,
    @Inject(GET_WAGER_TRANSACTION) private readonly getTransaction: IUseCase<GetWagerTransactionInput, WagerTransactionView>,
  ) {}

  @Post('wagering/transactions')
  @UseGuards(JsonContentTypeGuard)
  @HttpCode(200)
  @ApiSubmitWagerTransactionResponses()
  async submit(
    @BodyWithIdempotencyKey(SubmitWagerTransactionRequestDto)
    { body, idempotencyKey }: KeyedBody<SubmitWagerTransactionRequestDto>,
    @CurrentProvider() actor: AuthenticatedProvider,
    @CorrelationId() correlationId: string | undefined,
  ) {
    const money = { amount: body.money.amount, currency: body.money.currency };
    const output = await this.processTransaction.execute({
      actor,
      idempotencyKey,
      source: { channel: 'HTTP' },
      ...(correlationId === undefined ? {} : { correlationId }),
      payload: { ...body, playerId: body.playerId.toLowerCase(), walletId: body.walletId.toLowerCase(), money },
    });
    return toResult(output);
  }

  /** Transação de outro provider responde 404 igual a uma que não existe, a API nunca confirma que ela existe. */
  @Get('wagering/transactions/:transactionId')
  @ApiGetWagerTransactionResponses()
  async get(
    @Param('transactionId', new UuidParamPipe('transactionId')) transactionId: string,
    @CurrentProvider() actor: AuthenticatedProvider,
  ) {
    const view = await this.getTransaction.execute({ transactionId });
    if (view.providerId !== actor.providerId) throw new WagerTransactionNotFoundError(transactionId);
    return HttpResult.ok(view);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiGetProviderTransactionResponses()
  async getByExternalId(
    @Param('providerId', new TextParamPipe('providerId')) providerId: string,
    @Param('externalTransactionId', new TextParamPipe('externalTransactionId')) externalTransactionId: string,
    @CurrentProvider() actor: AuthenticatedProvider,
  ) {
    ensureOwner(actor, providerId);
    return HttpResult.ok(await this.getTransaction.execute({ providerId, externalTransactionId }));
  }
}
