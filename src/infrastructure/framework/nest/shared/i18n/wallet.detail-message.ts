import { error, type IDetailMessage, warning } from './detail-message';

const NS = 'WALLET';

export class WalletDetailMessage {
  static readonly WALLET_NOT_FOUND: IDetailMessage = error(NS, 'WALLET_NOT_FOUND');
  static readonly WALLET_PLAYER_MISMATCH: IDetailMessage = error(NS, 'WALLET_PLAYER_MISMATCH');
  static readonly WALLET_ALREADY_EXISTS: IDetailMessage = error(NS, 'WALLET_ALREADY_EXISTS');
  static readonly RECONCILIATION_DIVERGENCE: IDetailMessage = warning(NS, 'RECONCILIATION_DIVERGENCE');
}
