import { Wallet } from '../../../src/business/wallet/entity/wallet';

export const reconcile = (wallet: Wallet): boolean => wallet instanceof Wallet;
