/**
 * Stable code of the input rule a request broke. The domain only names the rule; turning it into a message is
 * the edge's job, so the code never changes when a text does.
 */
export const InputRule = {
  BLANK: 'BLANK',
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

/** Where in the request the rule broke (dotted path, e.g. `money.amount`) and which rule it was. */
export interface InputViolation {
  readonly field: string;
  readonly rule: InputRule;
}
