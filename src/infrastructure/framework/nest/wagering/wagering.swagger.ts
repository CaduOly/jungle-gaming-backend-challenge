import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation } from '@nestjs/swagger';
import { InfraDetailMessage } from '../shared/i18n/infra.detail-message';
import { ValidationDetailMessage } from '../shared/i18n/validation.detail-message';
import { WageringDetailMessage } from '../shared/i18n/wagering.detail-message';
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
import { IDEMPOTENCY_KEY_HEADER } from '../shared/validation/params';
import { SubmitWagerTransactionRequestDto } from './dto/submit-wager-transaction.request.dto';
import { WagerOutcomeDto, WagerTransactionDto } from './dto/wager-transaction.response.dto';

const TRANSACTION_ID = '0192f298-345e-7e38-af88-e43f851a819d';
const outcome = (status: string, amount: string, idempotentReplay = false) => ({
  transactionId: TRANSACTION_ID,
  status,
  balance: { amount, currency: 'BRL' },
  idempotentReplay,
});
const transaction = {
  transactionId: TRANSACTION_ID,
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
  status: 'PROCESSED',
  failureCode: null,
  referenceExternalTransactionId: null,
  referenceTransactionId: null,
  balance: { amount: '975.00', currency: 'BRL' },
  attempts: 0,
  nextAttemptAt: null,
  createdAt: '2026-07-29T15:00:00.000Z',
  processedAt: '2026-07-29T15:00:00.000Z',
};

const forbidden: EnvelopeResponse = {
  status: 403,
  description: 'The authenticated provider is not the transaction provider.',
  examples: {
    providerIdentityMismatch: problem('Acting for another provider', WageringDetailMessage.PROVIDER_IDENTITY_MISMATCH, 'providerId'),
  },
};
const common = [unauthorizedResponse, serviceUnavailableResponse, internalErrorResponse];

export const ApiSubmitWagerTransactionResponses = () =>
  applyDecorators(
    ApiOperation({ summary: 'Submit a wager transaction (idempotent by Idempotency-Key)' }),
    ApiBody({ type: SubmitWagerTransactionRequestDto }),
    ApiHeader({
      name: IDEMPOTENCY_KEY_HEADER,
      required: true,
      description: 'Source of truth for idempotency. Recommended: "{providerId}:{externalTransactionId}".',
      example: 'provider-a:transaction-123',
    }),
    ApiEnvelopeResponses(
      {
        status: 200,
        description: 'Applied (PROCESSED); a replay answers the same with idempotentReplay=true.',
        model: WagerOutcomeDto,
        examples: {
          processed: { summary: 'BET applied', data: outcome('PROCESSED', '975.00') },
          idempotentReplay: { summary: 'Same request again', data: outcome('PROCESSED', '975.00', true) },
        },
      },
      {
        status: 202,
        description: 'Accepted, waiting for its reference (PENDING_REFERENCE).',
        model: WagerOutcomeDto,
        examples: {
          pendingReference: {
            summary: 'ROLLBACK before its BET',
            data: outcome('PENDING_REFERENCE', '1000.00'),
            details: [{ ...WageringDetailMessage.REFERENCE_PENDING }],
          },
        },
      },
      {
        status: 400,
        description: 'Invalid request: one detail per field.',
        examples: {
          invalidMoneyAmount: problem('Amount with 3 decimals', ValidationDetailMessage.INVALID_MONEY_AMOUNT, 'money.amount'),
          invalidUuid: problem('walletId is not a UUID', ValidationDetailMessage.INVALID_UUID, 'walletId'),
          idempotencyKeyRequired: problem('Header missing', ValidationDetailMessage.IDEMPOTENCY_KEY_REQUIRED, IDEMPOTENCY_KEY_HEADER),
          openingNotSubmittable: problem('OPENING is internal', ValidationDetailMessage.KIND_NOT_SUBMITTABLE, 'kind'),
          amountMustBePositive: problem('BET of 0.00', ValidationDetailMessage.AMOUNT_MUST_BE_POSITIVE, 'money.amount'),
          referenceRequired: problem(
            'REFUND without reference',
            ValidationDetailMessage.REFERENCE_REQUIRED,
            'referenceExternalTransactionId',
          ),
          forbiddenKey: problem('__proto__ in the body', ValidationDetailMessage.FORBIDDEN_KEY, '__proto__'),
        },
      },
      ...bodyResponses,
      forbidden,
      {
        status: 404,
        description: 'Unknown wallet (nothing is persisted).',
        examples: { walletNotFound: problem('Unknown wallet', WalletDetailMessage.WALLET_NOT_FOUND, 'walletId') },
      },
      {
        status: 409,
        description: 'The key or the external id is already bound to a different request.',
        examples: {
          idempotencyConflict: problem('Same key, other payload', WageringDetailMessage.IDEMPOTENCY_CONFLICT, undefined, {
            existingTransactionId: TRANSACTION_ID,
          }),
          duplicateExternalTransaction: problem(
            'Same external id, other key',
            WageringDetailMessage.DUPLICATE_EXTERNAL_TRANSACTION,
            undefined,
            { existingTransactionId: TRANSACTION_ID },
          ),
        },
      },
      {
        status: 422,
        description: 'Rejected by a business rule (persisted: its replay answers 422 again).',
        model: WagerOutcomeDto,
        examples: {
          insufficientFunds: {
            summary: 'BET above the balance',
            data: outcome('REJECTED', '10.00'),
            details: [{ ...WageringDetailMessage.INSUFFICIENT_FUNDS }],
          },
          alreadyReversed: {
            summary: 'Second reversal of the same BET',
            data: outcome('REJECTED', '1000.00'),
            details: [{ ...WageringDetailMessage.ALREADY_REVERSED }],
          },
        },
      },
      ...common,
    ),
  );

const lookupResponses = (summary: string, invalidField: string) =>
  applyDecorators(
    ApiOperation({ summary }),
    ApiEnvelopeResponses(
      { status: 200, description: 'The transaction.', model: WagerTransactionDto, examples: { transaction: { summary: 'A BET', data: transaction } } },
      {
        status: 400,
        description: 'Invalid path parameter.',
        examples: {
          invalidParameter: problem(
            `${invalidField} is invalid`,
            invalidField === 'transactionId' ? ValidationDetailMessage.INVALID_UUID : ValidationDetailMessage.TOO_LONG,
            invalidField,
          ),
        },
      },
      ...(invalidField === 'transactionId' ? [] : [forbidden]),
      {
        status: 404,
        description:
          invalidField === 'transactionId'
            ? "No such transaction, or it belongs to another provider (the API never confirms it exists)."
            : 'No such transaction.',
        examples: { transactionNotFound: problem('Unknown transaction', WageringDetailMessage.TRANSACTION_NOT_FOUND) },
      },
      ...common,
    ),
  );

export const ApiGetWagerTransactionResponses = () => lookupResponses('Read a transaction by its id', 'transactionId');

export const ApiGetProviderTransactionResponses = () =>
  lookupResponses("Read a transaction by the provider's own id", 'externalTransactionId');

export const ApiCatalogResponses = () =>
  applyDecorators(
    ApiOperation({ summary: 'Every detail message (code, i18n key, type) for the front end translations' }),
    ApiEnvelopeResponses(
      {
        status: 200,
        description: 'The whole catalog.',
        examples: { catalog: { summary: 'Catalog', data: [WageringDetailMessage.INSUFFICIENT_FUNDS] } },
      },
      { status: 500, description: 'Unexpected error.', examples: { internalError: problem('Unexpected failure', InfraDetailMessage.INTERNAL_ERROR) } },
    ),
  );
