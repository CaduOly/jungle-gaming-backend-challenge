import { Wallet, type WalletState } from '../../../src/business/wallet/entity/wallet';
import { WalletAlreadyExistsError } from '../../../src/business/wallet/error/wallet-already-exists-error';
import type { IWalletRepository } from '../../../src/business/wallet/port/wallet.repository.port';
import { KeyedMutex, type Release } from './keyed-mutex';
import type { UndoLog } from './undo-log';

export class StaleWalletVersionError extends Error {
  constructor(walletId: string, expected: number, actual: number) {
    super(`Wallet ${walletId} is at version ${actual}, expected ${expected}`);
    this.name = 'StaleWalletVersionError';
  }
}

/** "Tabela" compartilhada de wallets mais o lock por wallet, compartilhada por todo repositório com escopo. */
export class InMemoryWalletStore {
  readonly locks = new KeyedMutex();
  private readonly rows = new Map<string, WalletState>();

  read(id: string): Wallet | null {
    const row = this.rows.get(id);
    return row === undefined ? null : Wallet.rehydrate(row);
  }

  write(wallet: Wallet): void {
    this.rows.set(wallet.id, wallet.toState());
  }

  /** Coloca uma linha de volta como estava (ou remove quando ela não existia): o rollback de uma escrita. */
  restore(id: string, state: WalletState | undefined): void {
    if (state === undefined) this.rows.delete(id);
    else this.rows.set(id, state);
  }

  snapshot(id: string): WalletState | undefined {
    return this.rows.get(id);
  }

  has(id: string): boolean {
    return this.rows.has(id);
  }

  findByPlayerAndCurrency(playerId: string, currency: string): Wallet | null {
    for (const row of this.rows.values()) {
      if (row.playerId === playerId && row.balance.currency === currency) return Wallet.rehydrate(row);
    }
    return null;
  }

  all(): Wallet[] {
    return [...this.rows.values()].map((row) => Wallet.rehydrate(row));
  }
}

/**
 * Repositório preso a uma unit of work. Os locks pegos pelo `lockById` ficam presos até o
 * `releaseLocks()`, que a fake unit of work chama no commit ou no rollback.
 * Mais rígido que o Postgres de propósito: o `update` exige a wallet com lock neste escopo.
 */
export class InMemoryWalletRepository implements IWalletRepository {
  private readonly held = new Map<string, Promise<Release>>();

  constructor(
    private readonly store: InMemoryWalletStore,
    private readonly undo?: UndoLog,
  ) {}

  async lockById(id: string): Promise<Wallet | null> {
    if (!this.store.has(id)) return null;
    let acquisition = this.held.get(id);
    if (acquisition === undefined) {
      acquisition = this.store.locks.acquire(id);
      this.held.set(id, acquisition);
    }
    await acquisition;
    return this.store.read(id);
  }

  async findById(id: string): Promise<Wallet | null> {
    return this.store.read(id);
  }

  async existsByPlayerAndCurrency(playerId: string, currency: string): Promise<boolean> {
    return this.store.findByPlayerAndCurrency(playerId, currency) !== null;
  }

  async insert(wallet: Wallet): Promise<void> {
    if (this.store.has(wallet.id)) throw new Error(`Wallet ${wallet.id} already exists`);
    if (this.store.findByPlayerAndCurrency(wallet.playerId, wallet.currency) !== null) {
      throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
    }
    this.journal(wallet.id);
    this.store.write(wallet);
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    if (!this.held.has(wallet.id)) throw new Error(`Wallet ${wallet.id} must be locked before update`);
    const current = this.store.read(wallet.id);
    if (current === null) throw new Error(`Wallet ${wallet.id} not found`);
    if (current.version !== expectedVersion) {
      throw new StaleWalletVersionError(wallet.id, expectedVersion, current.version);
    }
    this.journal(wallet.id);
    this.store.write(wallet);
  }

  private journal(id: string): void {
    const before = this.store.snapshot(id);
    this.undo?.record(() => this.store.restore(id, before));
  }

  holdsLock(id: string): boolean {
    return this.held.has(id);
  }

  async releaseLocks(): Promise<void> {
    const acquisitions = [...this.held.values()];
    this.held.clear();
    for (const release of await Promise.all(acquisitions)) release();
  }
}
