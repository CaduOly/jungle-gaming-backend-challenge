import { hostname } from 'node:os';

type Env = Readonly<Record<string, string | undefined>>;

export const APP_ROLES = ['api', 'consumer', 'outbox', 'pending-worker'] as const;

export type AppRole = (typeof APP_ROLES)[number];

const isAppRole = (value: string): value is AppRole => (APP_ROLES as readonly string[]).includes(value);

/**
 * APP_ROLES is a comma separated subset of api, consumer, outbox and pending-worker; empty or missing means all of
 * them. One image runs any mix, so a replica can be the whole service or a single worker.
 */
export const readAppRoles = (env: Env): ReadonlySet<AppRole> => {
  const raw = env.APP_ROLES?.trim() ?? '';
  if (raw === '') return new Set(APP_ROLES);
  const roles = raw.split(',').map((role) => role.trim());
  const unknown = roles.filter((role) => !isAppRole(role));
  if (unknown.length > 0) {
    throw new Error(`Invalid APP_ROLES: unknown role(s) ${unknown.join(', ')}; expected any of ${APP_ROLES.join(', ')}`);
  }
  return new Set(roles.filter(isAppRole));
};

const INSTANCE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** INSTANCE_ID when set, otherwise host and pid: unique per process, stable for its whole life. */
export const readInstanceId = (env: Env, fallback: () => string = () => `${hostname()}-${process.pid}`): string => {
  const raw = env.INSTANCE_ID?.trim() ?? '';
  if (raw === '') return fallback();
  if (!INSTANCE_ID.test(raw)) throw new Error(`Invalid INSTANCE_ID: "${raw}" (letters, digits, '.', '_' or '-', up to 64)`);
  return raw;
};
