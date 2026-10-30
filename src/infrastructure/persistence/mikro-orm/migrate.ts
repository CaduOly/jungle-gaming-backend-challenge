import { readDatabaseUrl } from '../../config/database-url';
import { migrateDown, migrateUp, type MigrationRun } from './migrator';

const USAGE = 'Usage: bun run src/infrastructure/persistence/mikro-orm/migrate.ts <up|down> [--all]';

const run = async (args: readonly string[]): Promise<MigrationRun> => {
  const [direction, ...flags] = args;
  const databaseUrl = readDatabaseUrl(process.env);
  if (direction === 'up' && flags.length === 0) return migrateUp(databaseUrl);
  if (direction === 'down' && flags.every((flag) => flag === '--all')) {
    return migrateDown(databaseUrl, { all: flags.includes('--all') });
  }
  throw new Error(USAGE);
};

try {
  const result = await run(process.argv.slice(2));
  const names = result.applied.length === 0 ? 'nothing to do' : result.applied.join(', ');
  console.log(`migrate ${result.direction}: ${names}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
