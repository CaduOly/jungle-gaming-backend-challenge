const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Reserved for the internal OPENING transactions: no credential may ever act as it. */
export const SYSTEM_PROVIDER = 'system';

export const isValidProviderId = (value: unknown): value is string => typeof value === 'string' && PROVIDER_ID.test(value);
