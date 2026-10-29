import { expect } from 'bun:test';
import type { IUseCase } from './use-case';

export const assertion = expect;
export type Checked = IUseCase<string, string>;
