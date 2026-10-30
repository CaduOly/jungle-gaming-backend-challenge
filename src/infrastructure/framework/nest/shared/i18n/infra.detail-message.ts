import { error, type IDetailMessage } from './detail-message';

const NS = 'INFRA';

export class InfraDetailMessage {
  static readonly UNAUTHORIZED: IDetailMessage = error(NS, 'UNAUTHORIZED');
  static readonly ROUTE_NOT_FOUND: IDetailMessage = error(NS, 'ROUTE_NOT_FOUND');
  static readonly INFRA_UNAVAILABLE: IDetailMessage = error(NS, 'INFRA_UNAVAILABLE');
  static readonly INTERNAL_ERROR: IDetailMessage = error(NS, 'INTERNAL_ERROR');
}
