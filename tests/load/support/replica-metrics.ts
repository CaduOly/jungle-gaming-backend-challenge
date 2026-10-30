import { parseExposition, sumSamples, type Samples } from './prometheus';
import { run } from './shell';

/** Faz scrape do /metrics dentro de cada réplica (o nginx mandaria cada scrape para uma qualquer) e soma tudo. */
export const scrapeReplicas = async (containers: readonly string[]): Promise<Samples> => {
  const scrapes = await Promise.all(
    containers.map(async (container) => {
      const { stdout } = await run(['docker', 'exec', container, 'wget', '-qO-', 'http://127.0.0.1:3000/metrics']);
      return parseExposition(stdout);
    }),
  );
  return sumSamples(scrapes);
};

export interface ContainerUsage {
  readonly name: string;
  readonly cpuPercent: number[];
  readonly memoryMiB: number[];
}

const MEMORY_UNITS: Record<string, number> = { B: 1 / 1024 ** 2, KiB: 1 / 1024, MiB: 1, GiB: 1024 };

const parseMemory = (usage: string): number => {
  const match = /^([\d.]+)\s*([KMG]?i?B)/.exec(usage.trim());
  if (match === null) return Number.NaN;
  return Number.parseFloat(match[1] ?? '') * (MEMORY_UNITS[match[2] ?? ''] ?? Number.NaN);
};

/** Amostra o `docker stats` até o `stop()`; quem chama lê as médias por container. */
export const sampleUsage = (containers: readonly string[], intervalMs = 3_000) => {
  const usage = new Map<string, ContainerUsage>();
  let running = true;
  const loop = (async () => {
    while (running) {
      const { stdout } = await run(
        ['docker', 'stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}', ...containers],
        { allowFailure: true },
      );
      for (const line of stdout.split('\n')) {
        const [name, cpu, memory] = line.split('\t');
        if (name === undefined || cpu === undefined || memory === undefined) continue;
        const entry = usage.get(name) ?? { name, cpuPercent: [], memoryMiB: [] };
        entry.cpuPercent.push(Number.parseFloat(cpu.replace('%', '')));
        entry.memoryMiB.push(parseMemory(memory));
        usage.set(name, entry);
      }
      await Bun.sleep(intervalMs);
    }
  })();
  return {
    stop: async (): Promise<ContainerUsage[]> => {
      running = false;
      await loop;
      return [...usage.values()];
    },
  };
};
