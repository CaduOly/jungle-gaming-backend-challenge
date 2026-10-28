export const LedgerDirection = {
  CREDIT: 'CREDIT',
  DEBIT: 'DEBIT',
} as const;

export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];
