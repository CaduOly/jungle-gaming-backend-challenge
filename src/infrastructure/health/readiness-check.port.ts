/** One dependency the instance cannot serve without. `check` resolves when it answers and rejects when it does not. */
export interface IReadinessCheck {
  readonly name: string;
  check(): Promise<void>;
}
