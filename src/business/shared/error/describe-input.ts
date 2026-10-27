export const describeInput = (value: unknown): string =>
  typeof value === 'string' ? JSON.stringify(value) : `<${value === null ? 'null' : typeof value}>`;
