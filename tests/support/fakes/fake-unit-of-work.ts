import type { TxRepositories } from '../../../src/business/wagering/port/tx-repositories.port';
import type { IUnitOfWork, UnitOfWorkOptions } from '../../../src/business/shared/port/unit-of-work.port';
import { InMemoryInboxRepository } from './in-memory-inbox.repository';
import { InMemoryLedger } from './in-memory-ledger';
import { InMemoryOutboxRepository } from './in-memory-outbox.repository';
import {
  InMemoryWagerTransactionRepository,
  InMemoryWagerTransactionStore,
} from './in-memory-wager-transaction-repository';
import { InMemoryWalletRepository, InMemoryWalletStore } from './in-memory-wallet-repository';
import { UndoLog } from './undo-log';

/** Every committed "table" the fake unit of work writes to. */
export class FakeDatabase {
  readonly wallets = new InMemoryWalletStore();
  readonly wagers = new InMemoryWagerTransactionStore();
  readonly ledger = new InMemoryLedger();
  readonly inbox = new InMemoryInboxRepository();
  readonly outbox = new InMemoryOutboxRepository();
}

export type FaultPoint = `${keyof TxRepositories}.${string}`;
type Hook = () => void | Promise<void>;

export class InjectedFaultError extends Error {
  constructor(readonly point: FaultPoint) {
    super(`Injected fault at ${point}`);
    this.name = 'InjectedFaultError';
  }
}

export class ReadOnlyTransactionError extends Error {
  constructor(point: string) {
    super(`${point} is a write inside a snapshot-read unit of work`);
    this.name = 'ReadOnlyTransactionError';
  }
}

const WRITES: ReadonlySet<string> = new Set([
  'insert',
  'update',
  'append',
  'add',
  'insertIfAbsent',
  'markProcessed',
  'claimPendingBatch',
]);

/**
 * In-memory stand-in for the MikroORM unit of work. Writes go straight to the shared stores (so, unlike
 * Postgres, concurrent units can read uncommitted rows) and are journaled: when `work` throws, the journal
 * is replayed backwards, which discards only this unit's writes and keeps what others committed meanwhile.
 * Row locks are released after the commit or the rollback, never before.
 */
export class FakeUnitOfWork implements IUnitOfWork<TxRepositories> {
  commits = 0;
  rollbacks = 0;
  /** Mode of every unit run so far, in order. */
  readonly modes: NonNullable<UnitOfWorkOptions['mode']>[] = [];
  private readonly hooks = new Map<string, { hook: Hook; remaining: number }[]>();

  constructor(readonly db: FakeDatabase = new FakeDatabase()) {}

  /** Runs `hook` before the next `times` calls to `point`; a hook that throws fails that call. */
  before(point: FaultPoint, hook: Hook, times = Number.POSITIVE_INFINITY): void {
    const hooks = this.hooks.get(point) ?? [];
    hooks.push({ hook, remaining: times });
    this.hooks.set(point, hooks);
  }

  failNext(point: FaultPoint, error: Error = new InjectedFaultError(point)): void {
    this.before(
      point,
      () => {
        throw error;
      },
      1,
    );
  }

  clearFaults(): void {
    this.hooks.clear();
  }

  async run<T>(work: (tx: TxRepositories) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    this.modes.push(options.mode ?? 'read-write');
    const undo = new UndoLog();
    const wallets = new InMemoryWalletRepository(this.db.wallets, undo);
    const wagers = new InMemoryWagerTransactionRepository(this.db.wagers, undo);
    const readOnly = options.mode === 'snapshot-read';
    const tx: TxRepositories = {
      wallets: this.instrument('wallets', wallets, readOnly),
      wagers: this.instrument('wagers', wagers, readOnly),
      ledger: this.instrument('ledger', this.db.ledger.withUndo(undo), readOnly),
      inbox: this.instrument('inbox', this.db.inbox.withUndo(undo), readOnly),
      outbox: this.instrument('outbox', this.db.outbox.withUndo(undo), readOnly),
    };
    try {
      const result = await work(tx);
      this.commits += 1;
      return result;
    } catch (error) {
      undo.rollback();
      this.rollbacks += 1;
      throw error;
    } finally {
      await wallets.releaseLocks();
      await wagers.releaseLocks();
    }
  }

  private instrument<R extends object>(name: keyof TxRepositories, repository: R, readOnly: boolean): R {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function' || typeof property !== 'string') return value;
        const point = `${name}.${property}` as FaultPoint;
        return async (...args: unknown[]) => {
          if (readOnly && WRITES.has(property)) throw new ReadOnlyTransactionError(point);
          await this.runHooks(point);
          return (value as (...params: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }

  private async runHooks(point: FaultPoint): Promise<void> {
    const hooks = this.hooks.get(point);
    if (hooks === undefined) return;
    for (const entry of [...hooks]) {
      if (entry.remaining <= 0) continue;
      entry.remaining -= 1;
      await entry.hook();
    }
    this.hooks.set(
      point,
      hooks.filter((entry) => entry.remaining > 0),
    );
  }
}
