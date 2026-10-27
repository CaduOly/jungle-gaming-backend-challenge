export interface SignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface GracefulShutdownOptions {
  readonly timeoutMs: number;
  readonly signals?: readonly NodeJS.Signals[];
  readonly source?: SignalSource;
  readonly exit?: (code: number) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * On the first SIGTERM/SIGINT runs `shutdown` and exits 0, also when `timeoutMs` expires first (whatever is
 * unfinished is recovered by redelivery). Exits 1 only when `shutdown` itself fails.
 */
export const installGracefulShutdown = (shutdown: () => Promise<unknown>, options: GracefulShutdownOptions): void => {
  const source = options.source ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let triggered = false;
  const onSignal = (): void => {
    if (triggered) return;
    triggered = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, options.timeoutMs);
    });
    Promise.race([shutdown(), timeout]).then(
      () => {
        clearTimeout(timer);
        exit(0);
      },
      (error: unknown) => {
        clearTimeout(timer);
        options.onError?.(error);
        exit(1);
      },
    );
  };
  for (const signal of options.signals ?? ['SIGTERM', 'SIGINT']) source.once(signal, onSignal);
};
