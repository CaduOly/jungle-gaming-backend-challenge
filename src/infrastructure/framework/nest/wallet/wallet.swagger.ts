import { applyDecorators } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { ValidationDetailMessage } from '../shared/i18n/validation.detail-message';
import { WalletDetailMessage } from '../shared/i18n/wallet.detail-message';
import {
  ApiEnvelopeResponses,
  bodyResponses,
  type EnvelopeResponse,
  internalErrorResponse,
  problem,
  serviceUnavailableResponse,
  unauthorizedResponse,
} from '../shared/swagger/envelope-responses';
import { LedgerPageDto, ReconciliationDto, WalletDto } from './dto/wallet.response.dto';

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const wallet = { id: WALLET_ID, playerId: PLAYER_ID, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 };

const walletNotFound: EnvelopeResponse = {
  status: 404,
  description: 'No wallet with this id.',
  examples: { walletNotFound: problem('Unknown wallet', WalletDetailMessage.WALLET_NOT_FOUND, 'walletId') },
};

const invalidWalletId: EnvelopeResponse = {
  status: 400,
  description: 'Invalid path or query parameter.',
  examples: { invalidUuid: problem('walletId is not a UUID', ValidationDetailMessage.INVALID_UUID, 'walletId') },
};

const common = [unauthorizedResponse, serviceUnavailableResponse, internalErrorResponse];

export const ApiCreateWalletResponses = () =>
  applyDecorators(
    ApiOperation({ summary: 'Open a wallet (a positive initial balance writes an OPENING credit)' }),
    ApiEnvelopeResponses(
      { status: 201, description: 'Wallet created.', model: WalletDto, examples: { created: { summary: 'Opened with 1000.00', data: wallet } } },
      {
        status: 400,
        description: 'Invalid body: one detail per field.',
        examples: {
          invalidMoneyAmount: problem('Amount with 3 decimals', ValidationDetailMessage.INVALID_MONEY_AMOUNT, 'initialBalance.amount'),
          invalidUuid: problem('playerId is not a UUID', ValidationDetailMessage.INVALID_UUID, 'playerId'),
          required: problem('initialBalance missing', ValidationDetailMessage.REQUIRED, 'initialBalance'),
          forbiddenKey: problem('__proto__ in the body', ValidationDetailMessage.FORBIDDEN_KEY, '__proto__'),
        },
      },
      ...bodyResponses,
      {
        status: 409,
        description: 'The player already has a wallet in this currency.',
        examples: { walletAlreadyExists: problem('Duplicate wallet', WalletDetailMessage.WALLET_ALREADY_EXISTS, 'playerId') },
      },
      ...common,
    ),
  );

export const ApiGetWalletResponses = () =>
  applyDecorators(
    ApiOperation({ summary: 'Read a wallet' }),
    ApiEnvelopeResponses(
      { status: 200, description: 'The wallet.', model: WalletDto, examples: { wallet: { summary: 'A wallet', data: wallet } } },
      invalidWalletId,
      walletNotFound,
      ...common,
    ),
  );

export const ApiGetLedgerResponses = () =>
  applyDecorators(
    ApiOperation({ summary: 'Page through the ledger, oldest first, with a stable opaque cursor' }),
    ApiEnvelopeResponses(
      {
        status: 200,
        description: 'One page of entries.',
        model: LedgerPageDto,
        examples: { lastPage: { summary: 'Last page', data: { walletId: WALLET_ID, entries: [], nextCursor: null } } },
      },
      {
        status: 400,
        description: 'Invalid walletId, cursor or limit.',
        examples: {
          invalidUuid: problem('walletId is not a UUID', ValidationDetailMessage.INVALID_UUID, 'walletId'),
          invalidCursor: problem('Tampered cursor', ValidationDetailMessage.INVALID_CURSOR, 'cursor'),
          invalidLimit: problem('limit out of range', ValidationDetailMessage.INVALID_LIMIT, 'limit'),
        },
      },
      walletNotFound,
      ...common,
    ),
  );

export const ApiReconcileWalletResponses = () =>
  applyDecorators(
    ApiOperation({ summary: 'Compare the stored balance with the ledger (reports, never corrects)' }),
    ApiEnvelopeResponses(
      {
        status: 200,
        description: 'Reconciliation report; a divergence adds a RECONCILIATION_DIVERGENCE warning.',
        model: ReconciliationDto,
        examples: {
          consistent: {
            summary: 'Balance matches the ledger',
            data: {
              walletId: WALLET_ID,
              storedBalance: { amount: '975.00', currency: 'BRL' },
              calculatedBalance: { amount: '975.00', currency: 'BRL' },
              difference: { amount: '0.00', currency: 'BRL' },
              consistent: true,
              checkedEntries: 42,
            },
          },
        },
      },
      invalidWalletId,
      walletNotFound,
      ...common,
    ),
  );
