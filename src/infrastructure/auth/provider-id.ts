const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Reservado para as transações internas de OPENING, nenhuma credencial pode agir como ele. */
export const SYSTEM_PROVIDER = 'system';

export const isValidProviderId = (value: unknown): value is string => typeof value === 'string' && PROVIDER_ID.test(value);
