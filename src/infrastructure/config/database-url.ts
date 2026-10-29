type Env = Readonly<Record<string, string | undefined>>;

const read = (env: Env, name: string, fallback: string): string => {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
};

/** DATABASE_URL wins; otherwise the URL is composed from the docker compose variables (see .env.example). */
export const readDatabaseUrl = (env: Env): string => {
  const explicit = env.DATABASE_URL;
  if (explicit !== undefined && explicit !== '') {
    if (!/^postgres(ql)?:\/\//.test(explicit)) throw new Error('Invalid DATABASE_URL: expected a postgres:// URL');
    return explicit;
  }
  const user = encodeURIComponent(read(env, 'POSTGRES_USER', 'wagering'));
  const password = encodeURIComponent(read(env, 'POSTGRES_PASSWORD', 'wagering'));
  const host = read(env, 'POSTGRES_HOST', 'localhost');
  const port = read(env, 'POSTGRES_HOST_PORT', '55432');
  const database = read(env, 'POSTGRES_DB', 'wagering');
  return `postgres://${user}:${password}@${host}:${port}/${database}`;
};
