export const WagerKind = {
  OPENING: 'OPENING',
  BET: 'BET',
  WIN: 'WIN',
  LOSS: 'LOSS',
  REFUND: 'REFUND',
  ROLLBACK: 'ROLLBACK',
} as const;

export type WagerKind = (typeof WagerKind)[keyof typeof WagerKind];
