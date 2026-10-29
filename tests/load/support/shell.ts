export interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ShellOptions {
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  /** Streams the output to the terminal instead of capturing it. */
  readonly inherit?: boolean;
  readonly allowFailure?: boolean;
}

export const run = async (command: readonly string[], options: ShellOptions = {}): Promise<ShellResult> => {
  const child = Bun.spawn([...command], {
    env: { ...process.env, ...options.env },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdout: options.inherit === true ? 'inherit' : 'pipe',
    stderr: options.inherit === true ? 'inherit' : 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout instanceof ReadableStream ? new Response(child.stdout).text() : Promise.resolve(''),
    child.stderr instanceof ReadableStream ? new Response(child.stderr).text() : Promise.resolve(''),
    child.exited,
  ]);
  if (exitCode !== 0 && options.allowFailure !== true) {
    throw new Error(`${command.join(' ')} exited with ${exitCode}\n${stderr || stdout}`);
  }
  return { exitCode, stdout, stderr };
};
