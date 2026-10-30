import type { OutboxMessage } from '../entity/outbox-message';

export interface IOutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;
  /**
   * Pega o lease de forma atômica de até `limit` mensagens vencidas (não publicadas, nextAttemptAt <= now, lease livre
   * ou expirado), na ordem em que foram adicionadas (ordem de commit), setando lockedUntil = now + leaseMs e um
   * leaseToken novo. Mensagem com lease não é pega de novo até o lease expirar, então publishers concorrentes nunca
   * dividem a mesma linha.
   *
   * Head-of-line: só a primeira mensagem não publicada de cada aggregate é elegível (ordem de commit, nunca
   * occurredAt, já que ele é lido antes do lock do aggregate e pode andar para trás entre commits), mesmo enquanto
   * essa cabeça está com lease ou esperando o retry. Assim os eventos de um aggregate saem em ordem, entre rodadas e
   * entre instâncias, no máximo um em voo por vez. O custo é que uma cabeça que falha sempre segura o aggregate
   * inteiro, ela nunca é descartada, e passar do teto de tentativas dispara o alerta de exhausted
   * (PublishOutboxBatchOutput.exhausted) para alguém olhar.
   */
  claimBatch(limit: number, leaseMs: number, now: Date): Promise<OutboxMessage[]>;
  /**
   * Registra a publicação e libera o lease. Não passa pelo fencing do lease token de propósito, já que a mensagem
   * chegou no broker, então até um publisher com lease expirado tem que registrar, senão a linha seria publicada
   * mais uma vez à toa. A entrega é at-least-once e os consumers fazem dedup por eventId, então uma marcação
   * atrasada não causa problema. Se a linha já está publicada não faz nada (retorna false, alguém registrou
   * antes) e nunca mexe em attempts nem em nextAttemptAt.
   */
  markPublished(message: OutboxMessage): Promise<boolean>;
  /**
   * Grava attempts/nextAttemptAt e libera o lease, só enquanto `message.leaseToken` ainda for dono da linha e
   * ela não estiver publicada (`… WHERE id = $1 AND published_at IS NULL AND lease_token = $2`).
   * Retorna false quando a escrita foi barrada pelo fencing: o lease expirou e outro publisher pegou a linha.
   */
  scheduleRetry(message: OutboxMessage): Promise<boolean>;
  findById(id: string): Promise<OutboxMessage | undefined>;
}
