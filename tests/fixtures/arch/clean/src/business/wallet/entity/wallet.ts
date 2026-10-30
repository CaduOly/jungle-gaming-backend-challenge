import type { IUseCase } from '../../shared/use-case';

export class Wallet {}
export type WalletUseCase = IUseCase<string, Wallet>;
