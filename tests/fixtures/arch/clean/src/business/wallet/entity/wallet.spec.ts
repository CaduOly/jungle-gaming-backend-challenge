import { expect } from 'bun:test';
import { FakeClock } from '../../../../tests/support/fakes/fake-clock';
import { Wallet } from './wallet';

export const deps = [expect, FakeClock, Wallet];
