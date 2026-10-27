import { describe, expect, it } from 'bun:test';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dir, '../..');
const eslint = new ESLint({ cwd: projectRoot });

const lint = async (code: string, filePath: string): Promise<string[]> => {
  const [result] = await eslint.lintText(code, { filePath: resolve(projectRoot, filePath) });
  return (result?.messages ?? []).map((message) => message.ruleId ?? 'fatal');
};

const MONEY_RULES = ['no-restricted-globals', 'no-restricted-properties', 'no-restricted-syntax', 'no-implicit-coercion'];

describe('money safety lint rules', () => {
  it.each([
    ['parseFloat', "export const a = parseFloat('1.10');"],
    ['Number.parseFloat', "export const a = Number.parseFloat('1.10');"],
    ['Number()', "export const a = Number('1.10');"],
    ['new Number()', "export const a = new Number('1.10');"],
    ['toFixed', 'export const a = (1.1).toFixed(2);'],
    ['toPrecision', 'export const a = (1.1).toPrecision(3);'],
    ['parseInt', "export const a = parseInt('110', 10);"],
    ['Number.parseInt', "export const a = Number.parseInt('110', 10);"],
    ['globalThis.Number', "export const a = globalThis.Number('1.10');"],
    ["globalThis['Number']", "export const a = globalThis['Number']('1.10');"],
    ['globalThis.parseFloat', "export const a = globalThis.parseFloat('1.10');"],
    ["globalThis['parseFloat']", "export const a = globalThis['parseFloat']('1.10');"],
    ['globalThis.parseInt', "export const a = globalThis.parseInt('110', 10);"],
    ["globalThis['parseInt']", "export const a = globalThis['parseInt']('110', 10);"],
    ['unary plus coercion', "const raw = '1.10';\nexport const a = +raw;"],
    ['alias of Number', "const N = Number;\nexport const a = N('1.10');"],
    ['Number passed as callback', "export const a = ['1.10'].map(Number);"],
  ])('rejects %s in src/business', async (_name, code) => {
    const rules = await lint(code, 'src/business/wallet/entity/fixture.ts');
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((rule) => MONEY_RULES.includes(rule))).toBe(true);
  });

  it('rejects the same patterns in src/infrastructure', async () => {
    const rules = await lint("export const a = Number('1.10');", 'src/infrastructure/persistence/fixture.ts');
    expect(rules).toEqual(['no-restricted-syntax']);
  });

  it.each([
    ['bigint arithmetic', "export const cents = BigInt('110') + 5n;"],
    ['static Number members', 'export const safe = Number.isSafeInteger(10) && Number.MAX_SAFE_INTEGER > 0;'],
    ['a property named Number', 'export const shape = { Number: 1 };\nexport const read = shape.Number;'],
    ['number type annotations', 'export const count = (items: readonly string[]): number => items.length;'],
  ])('accepts %s', async (_name, code) => {
    expect(await lint(code, 'src/business/shared/fixture.ts')).toEqual([]);
  });

  it('allows integer parsing only in the integer-env boundary file', async () => {
    const code = "export const port = Number.parseInt('3000', 10);";
    expect(await lint(code, 'src/infrastructure/config/integer-env.ts')).toEqual([]);
    expect(await lint(code, 'src/infrastructure/config/other.ts')).toEqual(['no-restricted-properties']);
  });
});

describe('pure business lint rules', () => {
  it.each([
    ['Math', 'export const a = Math.random();'],
    ['Bun', 'export const a = Bun.randomUUIDv7();'],
    ['process', 'export const a = process.env.FOO;'],
    ['globalThis.Math', 'export const a = globalThis.Math.random();'],
    ["globalThis['process']", "export const a = globalThis['process'];"],
  ])('rejects %s in src/business', async (_name, code) => {
    const rules = await lint(code, 'src/business/wagering/policy/fixture.ts');
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((rule) => rule === 'no-restricted-globals' || rule === 'no-restricted-properties')).toBe(true);
  });

  it('keeps the money rules active in src/business', async () => {
    expect(await lint("export const a = parseFloat('1');", 'src/business/wagering/policy/fixture.ts')).toEqual([
      'no-restricted-globals',
    ]);
  });

  it('allows Math, Bun and process outside src/business', async () => {
    const code = 'export const a = Math.max(1, 2) + process.pid;\nexport const b = Bun.version;';
    expect(await lint(code, 'src/infrastructure/clock/fixture.ts')).toEqual([]);
  });
});
