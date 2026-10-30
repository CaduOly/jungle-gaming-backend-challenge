/** Uma dependência sem a qual a instância não consegue atender. `check` resolve quando ela responde e rejeita quando não. */
export interface IReadinessCheck {
  readonly name: string;
  check(): Promise<void>;
}
