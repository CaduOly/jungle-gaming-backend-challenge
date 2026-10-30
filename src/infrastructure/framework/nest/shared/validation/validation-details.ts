import type { ValidationError } from 'class-validator';
import { type DetailMessage, detail } from '../envelope/api-response';
import type { IDetailMessage } from '../i18n/detail-message';
import { ValidationDetailMessage } from '../i18n/validation.detail-message';

const isDetailMessage = (value: unknown): value is IDetailMessage =>
  typeof value === 'object' && value !== null && 'code' in value && 'message' in value;

/** Constraints que o class-validator adiciona sozinho, sem decorator para carregar um context. */
const BUILT_IN: Readonly<Record<string, IDetailMessage>> = {
  whitelistValidation: ValidationDetailMessage.UNKNOWN_FIELD,
  nestedValidation: ValidationDetailMessage.MUST_BE_OBJECT,
};

const messageFor = (error: ValidationError, constraint: string): IDetailMessage => {
  const context: unknown = error.contexts?.[constraint];
  if (isDetailMessage(context)) return context;
  return BUILT_IN[constraint] ?? ValidationDetailMessage.INVALID_REQUEST;
};

/** Achata a árvore do class-validator em um detail por constraint que falhou, com o caminho do campo com ponto. */
export const validationDetails = (errors: readonly ValidationError[], parent = ''): DetailMessage[] =>
  errors.flatMap((error) => {
    const field = parent === '' ? error.property : `${parent}.${error.property}`;
    const own = Object.keys(error.constraints ?? {}).map((constraint) => detail(messageFor(error, constraint), field));
    return [...own, ...validationDetails(error.children ?? [], field)];
  });
