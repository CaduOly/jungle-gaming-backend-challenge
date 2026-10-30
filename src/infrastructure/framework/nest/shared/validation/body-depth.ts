/** Mais fundo que qualquer DTO da API e raso o suficiente para class-transformer e class-validator fazerem recursão sem risco. */
export const MAX_BODY_DEPTH = 32;

/**
 * Se um body JSON já parseado aninha objetos ou arrays em mais de `MAX_BODY_DEPTH` níveis. A varredura é iterativa
 * de propósito, uma recursiva estouraria a stack justamente nos bodies que ela existe para recusar.
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
