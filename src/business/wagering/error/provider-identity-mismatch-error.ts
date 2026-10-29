import { BusinessRuleError } from '../../shared/error/business-rule-error';
import { FailureCode } from '../../shared/error/failure-code';

export class ProviderIdentityMismatchError extends BusinessRuleError {
  constructor(
    readonly authenticatedProviderId: string,
    readonly payloadProviderId: string,
  ) {
    super(
      FailureCode.PROVIDER_IDENTITY_MISMATCH,
      `Provider ${authenticatedProviderId} cannot submit transactions as ${payloadProviderId}`,
    );
  }
}
