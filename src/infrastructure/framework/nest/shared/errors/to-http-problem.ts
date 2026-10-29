import { HttpException } from '@nestjs/common';
import { BusinessRuleError } from '../../../../../business/shared/error/business-rule-error';
import { InvalidRequestError } from '../../../../../business/shared/error/invalid-request-error';
import { WalletNotFoundError } from '../../../../../business/shared/error/wallet-not-found-error';
import { IdempotencyConflictError } from '../../../../../business/wagering/error/idempotency-conflict-error';
import { ProviderIdentityMismatchError } from '../../../../../business/wagering/error/provider-identity-mismatch-error';
import { WagerTransactionNotFoundError } from '../../../../../business/wagering/error/wager-transaction-not-found-error';
import { InvalidLedgerCursorError } from '../../../../../business/wallet/error/invalid-ledger-cursor-error';
import { WalletAlreadyExistsError } from '../../../../../business/wallet/error/wallet-already-exists-error';
import { UnauthenticatedError } from '../../../../auth/dev-provider-identity';
import { TransientInfrastructureError } from '../../../../error/transient-infrastructure-error';
import { detail } from '../envelope/api-response';
import { detailForFailureCode, detailForInputRule } from '../i18n/catalog';
import { InfraDetailMessage } from '../i18n/infra.detail-message';
import { ValidationDetailMessage } from '../i18n/validation.detail-message';
import { WageringDetailMessage } from '../i18n/wagering.detail-message';
import { WalletDetailMessage } from '../i18n/wallet.detail-message';
import { HttpProblem } from './http-problem';

export interface HttpProblemOptions {
  readonly retryAfterSeconds: number;
}

/** Express answers a path with a broken percent-encoding (`/wallets/%E0%A4%A`) with this message, and only that. */
const isUndecodablePath = (error: HttpException): boolean => {
  const response = error.getResponse();
  const message = typeof response === 'object' && response !== null ? (response as { message?: unknown }).message : response;
  return typeof message === 'string' && message.startsWith('Failed to decode param');
};

const fromNestException = (error: HttpException): HttpProblem => {
  const status = error.getStatus();
  if (status === 404) return new HttpProblem(404, [detail(InfraDetailMessage.ROUTE_NOT_FOUND)]);
  if (status === 401) return new HttpProblem(401, [detail(InfraDetailMessage.UNAUTHORIZED)]);
  if (status === 413) return new HttpProblem(413, [detail(ValidationDetailMessage.PAYLOAD_TOO_LARGE)]);
  if (status === 415) return new HttpProblem(415, [detail(ValidationDetailMessage.UNSUPPORTED_MEDIA_TYPE)]);
  if (status === 400 && isUndecodablePath(error)) {
    return new HttpProblem(400, [detail(ValidationDetailMessage.MALFORMED_PATH, 'path')]);
  }
  if (status >= 400 && status < 500) return new HttpProblem(400, [detail(ValidationDetailMessage.MALFORMED_BODY)]);
  return new HttpProblem(500, [detail(InfraDetailMessage.INTERNAL_ERROR)]);
};

/**
 * Error → status, following docs/http-contract.md. Order matters: the specific errors come before the
 * BusinessRuleError fallback (WALLET_NOT_FOUND and PROVIDER_IDENTITY_MISMATCH are business rule errors
 * but answer 404 and 403). Anything unrecognised is a 500 that carries no internal message.
 */
export const toHttpProblem = (error: unknown, options: HttpProblemOptions): HttpProblem => {
  if (error instanceof HttpProblem) return error;
  if (error instanceof UnauthenticatedError) return new HttpProblem(401, [detail(InfraDetailMessage.UNAUTHORIZED)]);
  if (error instanceof InvalidRequestError) {
    return new HttpProblem(400, [detail(detailForInputRule(error.rule), error.field)]);
  }
  if (error instanceof InvalidLedgerCursorError) {
    return new HttpProblem(400, [detail(ValidationDetailMessage.INVALID_CURSOR, 'cursor')]);
  }
  if (error instanceof ProviderIdentityMismatchError) {
    return new HttpProblem(403, [detail(WageringDetailMessage.PROVIDER_IDENTITY_MISMATCH, 'providerId')]);
  }
  if (error instanceof WalletNotFoundError) {
    return new HttpProblem(404, [detail(WalletDetailMessage.WALLET_NOT_FOUND, 'walletId')]);
  }
  if (error instanceof WagerTransactionNotFoundError) {
    return new HttpProblem(404, [detail(WageringDetailMessage.TRANSACTION_NOT_FOUND)]);
  }
  if (error instanceof IdempotencyConflictError) {
    return new HttpProblem(409, [detail(detailForFailureCode(error.failureCode))], {
      existingTransactionId: error.existingTransactionId,
    });
  }
  if (error instanceof WalletAlreadyExistsError) {
    return new HttpProblem(409, [detail(WalletDetailMessage.WALLET_ALREADY_EXISTS, 'playerId')]);
  }
  if (error instanceof BusinessRuleError) return new HttpProblem(422, [detail(detailForFailureCode(error.failureCode))]);
  if (error instanceof TransientInfrastructureError) {
    return new HttpProblem(503, [detail(InfraDetailMessage.INFRA_UNAVAILABLE)], null, {
      'Retry-After': `${options.retryAfterSeconds}`,
    });
  }
  if (error instanceof HttpException) return fromNestException(error);
  return new HttpProblem(500, [detail(InfraDetailMessage.INTERNAL_ERROR)]);
};
