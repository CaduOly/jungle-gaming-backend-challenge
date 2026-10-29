/** Deeper than any DTO of the API, and shallow enough for class-transformer and class-validator to recurse safely. */
export const MAX_BODY_DEPTH = 32;

/**
 * Whether a parsed JSON body nests objects or arrays more than `MAX_BODY_DEPTH` levels. The walk is iterative on
 * purpose: a recursive one would overflow the stack on the very bodies it exists to refuse.
 */
export const exceedsBodyDepth = (value: unknown): boolean => {
  const pending: Array<{ readonly node: unknown; readonly depth: number }> = [{ node: value, depth: 1 }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next.node !== 'object' || next.node === null) continue;
    if (next.depth > MAX_BODY_DEPTH) return true;
    for (const child of Object.values(next.node)) pending.push({ node: child, depth: next.depth + 1 });
  }
  return false;
};
