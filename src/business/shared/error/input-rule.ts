/**
 * Código estável da regra de input que a requisição quebrou. O domínio só nomeia a regra, transformar em mensagem
 * é papel da borda, então o código não muda quando um texto muda.
 */
export const InputRule = {
  BLANK: 'BLANK',
  SURROUNDING_WHITESPACE: 'SURROUNDING_WHITESPACE',
  NUL_CHARACTER: 'NUL_CHARACTER',
  INVALID_UUID: 'INVALID_UUID',
  INVALID_KIND: 'INVALID_KIND',
  KIND_NOT_SUBMITTABLE: 'KIND_NOT_SUBMITTABLE',
  INVALID_MONEY_AMOUNT: 'INVALID_MONEY_AMOUNT',
  INVALID_CURRENCY: 'INVALID_CURRENCY',
  AMOUNT_MUST_BE_POSITIVE: 'AMOUNT_MUST_BE_POSITIVE',
  REFERENCE_REQUIRED: 'REFERENCE_REQUIRED',
  REFERENCE_NOT_ALLOWED: 'REFERENCE_NOT_ALLOWED',
  SELF_REFERENCE: 'SELF_REFERENCE',
} as const;

export type InputRule = (typeof InputRule)[keyof typeof InputRule];

/** Onde na requisição a regra quebrou (caminho com ponto, ex.: `money.amount`) e qual foi a regra. */
export interface InputViolation {
  readonly field: string;
  readonly rule: InputRule;
}
