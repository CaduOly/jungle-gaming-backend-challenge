import { OutboxMessage, type OutboxMessageState } from '../../../src/business/messaging/entity/outbox-message';
import type { IOutboxRepository } from '../../../src/business/messaging/port/outbox.repository.port';
import { uuidv7 } from '../uuid';
import type { UndoLog } from './undo-log';

const withoutLease = ({ lockedUntil: _lockedUntil, leaseToken: _leaseToken, ...rest }: OutboxMessageState) => rest;

/**
 * Head-of-line igual ao claim real: só a primeira mensagem não publicada adicionada (menor seq) de cada aggregate
 * é elegível. O `seq` espelha a coluna bigserial: cresce a cada add, na ordem de commit.
 * Substituto single-thread de `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`: todo método roda sem
 * await no meio, então um claim é atômico em relação aos outros chamadores.
 */
export class InMemoryOutboxRepository implements IOutboxRepository {
  private readonly rows = new Map<string, OutboxMessageState>();
  private readonly seqs = new Map<string, number>();
  private nextSeq = 0;

  async add(messages: readonly OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      if (this.rows.has(message.id)) throw new Error(`Outbox message ${message.id} already exists`);
    }
    for (const message of messages) {
      this.rows.set(message.id, withoutLease(message.toState()));
      this.seqs.set(message.id, (this.nextSeq += 1));
    }
  }

  async claimBatch(limit: number, leaseMs: number, now: Date): Promise<OutboxMessage[]> {
    const lockedUntil = new Date(now.getTime() + leaseMs);
    const heads = new Map<string, OutboxMessageState>();
    const bySeq = (a: OutboxMessageState, b: OutboxMessageState): number => this.seqOf(a.id) - this.seqOf(b.id);
    for (const row of [...this.rows.values()].filter((stored) => !stored.publishedAt).sort(bySeq)) {
      if (!heads.has(row.aggregateId)) heads.set(row.aggregateId, row);
    }
    const claimed = [...heads.values()]
      .filter((row) => OutboxMessage.rehydrate(row).isDue(now))
      .sort(bySeq)
      .slice(0, limit)
      .map((row) => ({ ...row, lockedUntil, leaseToken: uuidv7() }));
    for (const row of claimed) this.rows.set(row.id, row);
    return claimed.map((row) => OutboxMessage.rehydrate(row));
  }

  async markPublished(message: OutboxMessage): Promise<boolean> {
    const stored = this.require(message.id);
    if (stored.publishedAt) return false;
    this.rows.set(message.id, { ...withoutLease(stored), publishedAt: message.publishedAt });
    return true;
  }

  async scheduleRetry(message: OutboxMessage): Promise<boolean> {
    const stored = this.require(message.id);
    if (stored.publishedAt || message.leaseToken === undefined || stored.leaseToken !== message.leaseToken) {
      return false;
    }
    this.rows.set(message.id, {
      ...withoutLease(stored),
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt,
    });
    return true;
  }

  async findById(id: string): Promise<OutboxMessage | undefined> {
    const stored = this.rows.get(id);
    return stored && OutboxMessage.rehydrate(stored);
  }

  /** View presa a uma unit of work: um rollback remove o que ela enfileirou. */
  withUndo(undo: UndoLog): Pick<IOutboxRepository, 'add'> {
    return {
      add: async (messages) => {
        await this.add(messages);
        undo.record(() => {
          for (const message of messages) {
            this.rows.delete(message.id);
            this.seqs.delete(message.id);
          }
        });
      },
    };
  }

  all(): OutboxMessage[] {
    return [...this.rows.values()].map((row) => OutboxMessage.rehydrate(row));
  }

  pending(): OutboxMessage[] {
    return [...this.rows.values()].filter((row) => !row.publishedAt).map((row) => OutboxMessage.rehydrate(row));
  }

  private seqOf(id: string): number {
    return this.seqs.get(id) ?? Number.MAX_SAFE_INTEGER;
  }

  private require(id: string): OutboxMessageState {
    const stored = this.rows.get(id);
    if (!stored) throw new Error(`Outbox message ${id} does not exist`);
    return stored;
  }
}
