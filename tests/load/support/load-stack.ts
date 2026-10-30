import { join } from 'node:path';
import { run } from './shell';

export interface LoadStackConfig {
  readonly root: string;
  readonly project: string;
  readonly databaseUrl: string;
  readonly commandsQueue: string;
  readonly commandsDlq: string;
  readonly eventsQueue: string;
}

/**
 * docker-compose.app.yml + tests/load/docker-compose.load.yml num project próprio. O `down` remove só o que
 * este project criou (containers e a rede `load` dele); a infraestrutura compartilhada continua de pé.
 */
export class LoadStack {
  private constructor(private readonly config: LoadStackConfig) {}

  static create(config: LoadStackConfig): LoadStack {
    return new LoadStack(config);
  }

  get project(): string {
    return this.config.project;
  }

  get network(): string {
    return `${this.config.project}_load`;
  }

  private compose(args: readonly string[], inherit = false) {
    return run(
      [
        'docker',
        'compose',
        '-p',
        this.config.project,
        '-f',
        join(this.config.root, 'docker-compose.app.yml'),
        '-f',
        join(this.config.root, 'tests/load/docker-compose.load.yml'),
        ...args,
      ],
      {
        cwd: this.config.root,
        inherit,
        env: {
          LOAD_DATABASE_URL: this.config.databaseUrl,
          LOAD_COMMANDS_QUEUE: this.config.commandsQueue,
          LOAD_COMMANDS_DLQ: this.config.commandsDlq,
          LOAD_EVENTS_QUEUE: this.config.eventsQueue,
        },
      },
    );
  }

  async up(): Promise<void> {
    await this.compose(['build', 'migrate'], true);
    await this.compose(['up', '-d', '--wait', '--wait-timeout', '180', 'app', 'nginx'], true);
  }

  async baseUrl(): Promise<string> {
    const { stdout } = await this.compose(['port', 'nginx', '80']);
    const address = stdout.trim();
    if (address === '') throw new Error('nginx did not publish a port');
    return `http://${address}`;
  }

  async appContainers(): Promise<string[]> {
    const { stdout } = await this.compose(['ps', '-q', 'app']);
    return stdout.split('\n').filter((id) => id !== '');
  }

  async nginxContainer(): Promise<string> {
    const { stdout } = await this.compose(['ps', '-q', 'nginx']);
    return stdout.trim();
  }

  async down(): Promise<void> {
    await this.compose(['down', '--volumes', '--remove-orphans', '--timeout', '30'], true);
  }
}
