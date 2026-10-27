import 'reflect-metadata';
import type { Provider } from '@nestjs/common';
import { readHttpConfig } from './infrastructure/framework/nest/shared/http-config';
import { createHttpApp } from './infrastructure/framework/nest/shared/http-app';

/**
 * Starts the HTTP API over the given persistence binding (WAGERING_PERSISTENCE). The PostgreSQL binding
 * arrives with T07b; until then `bun run start:in-memory` serves the API over the in-memory fakes.
 */
export const bootstrap = async (persistence: Provider): Promise<void> => {
  const app = await createHttpApp({ persistence });
  await app.listen(readHttpConfig(process.env).port);
};

if (import.meta.main) {
  throw new Error('No persistence is wired yet (T07b). Use `bun run start:in-memory` for a local API over the fakes.');
}
