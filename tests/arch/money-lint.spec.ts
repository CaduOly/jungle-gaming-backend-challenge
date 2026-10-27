import { describe, expect, it } from 'bun:test';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dir, '../..');
const eslint = new ESLint({ cwd: projectRoot });

const lint = async (code: string, filePath: string): Promise<string[]> => {
  const [result] = await eslint.lintText(code, { filePath: resolve(projectRoot, filePath) });
  return (result?.messages ?? []).map((message) => message.ruleId ?? 'fatal');
};

describe('money safety lint rules', () => {
  it.each([
    ['parseFloat', "export const a = parseFloat('1.10');"],
    ['Number.parseFloat', "export const a = Number.parseFloat('1.10');"],
    ['Number()', "export const a = Number('1.10');"],
    ['new Number()', "export const a = new Number('1.10');"],
    ['toFixed', 'export const a = (1.1).toFixed(2);'],
    ['parseInt', "export const a = parseInt('110', 10);"],
    ['Number.parseInt', "export const a = Number.parseInt('110', 10);"],
  ])('rejects %s in src/business', async (_name, code) => {
    const rules = await lint(code, 'src/business/wallet/entity/fixture.ts');
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((rule) => rule.startsWith('no-restricted-'))).toBe(true);
  });

  it('rejects the same patterns in src/infrastructure', async () => {
    const rules = await lint("export const a = Number('1.10');", 'src/infrastructure/persistence/fixture.ts');
    expect(rules).toEqual(['no-restricted-syntax']);
  });

  it('accepts bigint based arithmetic', async () => {
    const rules = await lint("export const cents = BigInt('110') + 5n;", 'src/business/shared/fixture.ts');
    expect(rules).toEqual([]);
  });

  it('allows integer parsing only in the config boundary', async () => {
    const rules = await lint("export const port = Number.parseInt('3000', 10);", 'src/infrastructure/config/fixture.ts');
    expect(rules).toEqual([]);
  });
});
