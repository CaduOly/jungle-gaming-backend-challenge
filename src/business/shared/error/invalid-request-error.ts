import { DomainError } from './domain-error';
import type { InputRule } from './input-rule';

/** Input malformado no use case (400): a requisição só passa se quem chamou mudar ela. */
export class InvalidRequestError extends DomainError {
  constructor(
    /** Caminho com ponto do campo com problema, ex.: `money.amount`. */
    readonly field: string,
    readonly reason: string,
    readonly rule?: InputRule,
  ) {
    super(`Invalid request: ${field} ${reason}`);
  }
}
