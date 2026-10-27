import { LedgerDirection } from './ledger-direction';

export const LedgerEntryType = {
  OPENING: 'OPENING',
  BET: 'BET',
  WIN: 'WIN',
  REFUND: 'REFUND',
  ROLLBACK: 'ROLLBACK',
} as const;

export type LedgerEntryType = (typeof LedgerEntryType)[keyof typeof LedgerEntryType];

const ALLOWED_DIRECTIONS: Readonly<Record<LedgerEntryType, readonly LedgerDirection[]>> = {
  OPENING: [LedgerDirection.CREDIT],
  BET: [LedgerDirection.DEBIT],
  WIN: [LedgerDirection.CREDIT],
  REFUND: [LedgerDirection.CREDIT],
  ROLLBACK: [LedgerDirection.CREDIT, LedgerDirection.DEBIT],
};

export const isDirectionAllowedFor = (entryType: LedgerEntryType, direction: LedgerDirection): boolean =>
  ALLOWED_DIRECTIONS[entryType].includes(direction);
