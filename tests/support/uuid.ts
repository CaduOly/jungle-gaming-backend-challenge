const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const uuidv7 = (): string => Bun.randomUUIDv7();

export const isUuidV7 = (value: string): boolean => UUID_V7_PATTERN.test(value);

export const uniqueSuffix = (): string => uuidv7().replaceAll('-', '');
