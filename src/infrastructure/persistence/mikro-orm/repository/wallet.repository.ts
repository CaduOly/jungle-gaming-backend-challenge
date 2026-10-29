import type { EntityManager } from '@mikro-orm/postgresql';
import { UniqueConstraintViolationError } from '../../../../business/shared/error/unique-constraint-violation-error';
import type { Wallet } from '../../../../business/wallet/entity/wallet';
import { WalletAlreadyExistsError } from '../../../../business/wallet/error/wallet-already-exists-error';
import type { IWalletRepository } from '../../../../business/wallet/port/wallet.repository.port';
import { PermanentInfrastructureError } from '../../../error/permanent-infrastructure-error';
import { translateDatabaseError } from '../../database-error';
import { WALLET_COLUMNS, walletFromRow, type WalletRow, walletToInsertParams } from '../mapper/wallet.mapper';
import { isUuid } from '../mapper/sql-values';
import type { RunResult } from './run-result';

const PLAYER_CURRENCY_UNIQUE = 'wallets_player_currency_unique';

/**
 * Native SQL only: the wallet is never tracked by the identity map, so there is no dirty check and the single
 * write path is `update`, which moves the version forward by exactly one under the row lock.
 */
export class WalletRepository implements IWalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockById(id: string): Promise<Wallet | null> {
    return this.selectOne(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ? FOR UPDATE`, id);
  }

  async findById(id: string): Promise<Wallet | null> {
    return this.selectOne(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ?`, id);
  }

  async existsByPlayerAndCurrency(playerId: string, currency: string): Promise<boolean> {
    if (!isUuid(playerId)) return false;
    const [row] = await this.em.execute<{ found: boolean }[]>(
      'SELECT EXISTS (SELECT 1 FROM wallets WHERE player_id = ? AND currency = ?) AS found',
      [playerId, currency],
    );
    return row?.found === true;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.execute(
        `INSERT INTO wallets (${WALLET_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        walletToInsertParams(wallet),
        'run',
      );
    } catch (error) {
      const translated = translateDatabaseError(error);
      if (translated instanceof UniqueConstraintViolationError && translated.constraint === PLAYER_CURRENCY_UNIQUE) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw translated;
    }
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    if (wallet.version !== expectedVersion + 1) {
      throw new PermanentInfrastructureError(
        `Wallet ${wallet.id} moved from version ${expectedVersion} to ${wallet.version}; one update is one step`,
        undefined,
        { cause: undefined },
      );
    }
    const result = await this.em.execute<RunResult>(
      'UPDATE wallets SET balance = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
      [wallet.balance.amount, wallet.updatedAt, wallet.id, expectedVersion],
      'run',
    );
    if (result.affectedRows !== 1) {
      throw new PermanentInfrastructureError(
        `Wallet ${wallet.id} is not at version ${expectedVersion}: updated without holding its lock`,
        undefined,
        { cause: undefined },
      );
    }
  }

  private async selectOne(sql: string, id: string): Promise<Wallet | null> {
    if (!isUuid(id)) return null;
    const [row] = await this.em.execute<WalletRow[]>(sql, [id]);
    return row === undefined ? null : walletFromRow(row);
  }
}
