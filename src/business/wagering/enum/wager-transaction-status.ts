export const WagerTransactionStatus = {
  PENDING: 'PENDING',
  PENDING_REFERENCE: 'PENDING_REFERENCE',
  PROCESSED: 'PROCESSED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
} as const;

export type WagerTransactionStatus = (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];
