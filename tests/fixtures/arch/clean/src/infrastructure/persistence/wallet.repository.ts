import { MikroORM } from '@mikro-orm/core';
import { Wallet } from '../../business/wallet/entity/wallet';

export const deps = [MikroORM, Wallet];
