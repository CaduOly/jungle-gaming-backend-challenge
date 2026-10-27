import type { ValidationOptions } from 'class-validator';
import type { IDetailMessage } from '../i18n/detail-message';

/** Validation options that carry the catalog entry the pipe turns into a detail. */
export const withDetail = (message: IDetailMessage, options: ValidationOptions = {}): ValidationOptions => ({
  ...options,
  context: message,
});
