const MAX_ECHOED_LENGTH = 32;

export const describeInput = (value: unknown): string => {
  if (typeof value !== 'string') return `<${value === null ? 'null' : typeof value}>`;
  const echoed = value.length > MAX_ECHOED_LENGTH ? `${value.slice(0, MAX_ECHOED_LENGTH)}…` : value;
  return JSON.stringify(echoed);
};
