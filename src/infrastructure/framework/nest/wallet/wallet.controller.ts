import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { CreateWallet } from '../../../../business/wallet/use-case/create-wallet/create-wallet';
import { type GetLedger, MAX_LEDGER_LIMIT } from '../../../../business/wallet/use-case/get-ledger/get-ledger';
import type { GetWallet } from '../../../../business/wallet/use-case/get-wallet/get-wallet';
import type { ReconcileWallet } from '../../../../business/wallet/use-case/reconcile-wallet/reconcile-wallet';
import { CREATE_WALLET, GET_LEDGER, GET_WALLET, RECONCILE_WALLET } from '../shared/di/tokens';
import { detail } from '../shared/envelope/api-response';
import { HttpResult } from '../shared/envelope/http-result';
import { HttpProblem } from '../shared/errors/http-problem';
import { ValidationDetailMessage } from '../shared/i18n/validation.detail-message';
import { WalletDetailMessage } from '../shared/i18n/wallet.detail-message';
import { LimitQueryPipe, UuidParamPipe } from '../shared/validation/params';
import { CreateWalletRequestDto } from './dto/create-wallet.request.dto';
import {
  ApiCreateWalletResponses,
  ApiGetLedgerResponses,
  ApiGetWalletResponses,
  ApiReconcileWalletResponses,
} from './wallet.swagger';

const MAX_CURSOR_LENGTH = 512;

@ApiTags('wallets')
@ApiBearerAuth()
@Controller('wallets')
export class WalletController {
  constructor(
    @Inject(CREATE_WALLET) private readonly createWallet: CreateWallet,
    @Inject(GET_WALLET) private readonly getWallet: GetWallet,
    @Inject(GET_LEDGER) private readonly getLedger: GetLedger,
    @Inject(RECONCILE_WALLET) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @ApiCreateWalletResponses()
  async create(@Body() body: CreateWalletRequestDto) {
    const initialBalance = { amount: body.initialBalance.amount, currency: body.initialBalance.currency };
    return HttpResult.created(await this.createWallet.execute({ playerId: body.playerId.toLowerCase(), initialBalance }));
  }

  @Get(':walletId')
  @ApiGetWalletResponses()
  async get(@Param('walletId', new UuidParamPipe('walletId')) walletId: string) {
    return HttpResult.ok(await this.getWallet.execute({ walletId }));
  }

  @Get(':walletId/ledger')
  @ApiQuery({ name: 'cursor', required: false, description: 'nextCursor of the previous page.' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: MAX_LEDGER_LIMIT, default: 50 } })
  @ApiGetLedgerResponses()
  async ledger(
    @Param('walletId', new UuidParamPipe('walletId')) walletId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit', new LimitQueryPipe(MAX_LEDGER_LIMIT)) limit: number | undefined,
  ) {
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH)) {
      throw new HttpProblem(400, [detail(ValidationDetailMessage.INVALID_CURSOR, 'cursor')]);
    }
    return HttpResult.ok(
      await this.getLedger.execute({
        walletId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  @ApiReconcileWalletResponses()
  async reconcile(@Param('walletId', new UuidParamPipe('walletId')) walletId: string) {
    const { divergences: _divergences, ...report } = await this.reconcileWallet.execute({ walletId });
    return HttpResult.ok(report, report.consistent ? [] : [detail(WalletDetailMessage.RECONCILIATION_DIVERGENCE)]);
  }
}
