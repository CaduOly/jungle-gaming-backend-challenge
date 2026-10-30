import type { ValidationOptions } from 'class-validator';
import type { IDetailMessage } from '../i18n/detail-message';

/** Opções de validação que carregam a entrada do catálogo que o pipe transforma em detail. */
export const withDetail = (message: IDetailMessage, options: ValidationOptions = {}): ValidationOptions => ({
  ...options,
  context: message,
});
