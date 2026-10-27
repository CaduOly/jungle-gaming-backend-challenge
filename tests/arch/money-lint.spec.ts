import { describe, expect, it } from 'bun:test';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dir, '../..');
const eslint = new ESLint({ cwd: projectRoot });

const lintMessages = async (code: string, filePath: string) => {
  const [result] = await eslint.lintText(code, { filePath: resolve(projectRoot, filePath) });
  return result?.messages ?? [];
};

const lint = async (code: string, filePath: string): Promise<string[]> =>
  (await lintMessages(code, filePath)).map((message) => message.ruleId ?? 'fatal');

const MONEY_RULES = ['no-restricted-globals', 'no-restricted-properties', 'no-restricted-syntax'];

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
    ['double negation coercion', "const raw = '1.10';\nexport const a = - -raw;"],
    ['multiply by 1 coercion', "const raw = '1.10';\nexport const a = 1 * (raw as unknown as number);"],
    ['subtract 0 coercion', "const raw = '1.10';\nexport const a = (raw as unknown as number) - 0;"],
    ['alias of Number', "const N = Number;\nexport const a = N('1.10');"],
    ['Number passed as callback', "export const a = ['1.10'].map(Number);"],
    ['bitwise not coercion', "const raw = '1.10';\nexport const a = ~raw;"],
    ['double bitwise not coercion', "const raw = '1.10';\nexport const a = ~~raw;"],
    ['unary minus on a value', "const raw = '1.10';\nexport const a = -raw;"],
    ['unary minus on a bigint value', 'export const negate = (cents: bigint): bigint => -cents;'],
    ['unary minus on a call', "export const a = -Number.parseFloat('1.10');"],
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
    ['bigint subtraction of zero', 'export const same = (cents: bigint): bigint => cents - 0n;'],
    ['bigint multiplication by one', 'export const same = (cents: bigint): bigint => 1n * cents * 1n;'],
    ['unary minus on a literal', 'export const offsets = [-1, -1n, -0.5];'],
  ])('accepts %s', async (_name, code) => {
    expect(await lint(code, 'src/business/shared/fixture.ts')).toEqual([]);
  });

  it('points coercion offenders at Money instead of suggesting Number()', async () => {
    const [message] = await lintMessages("const raw = '1';\nexport const a = +raw;", 'src/business/fixture.ts');
    expect(message?.message).toContain('Money value object');
    expect(message?.message).not.toContain('Number(');
  });

  it('allows integer parsing only in the integer-env boundary file', async () => {
    const code = "export const port = Number.parseInt('3000', 10);";
    expect(await lint(code, 'src/infrastructure/config/integer-env.ts')).toEqual([]);
    expect(await lint("export const port = parseInt('3000', 10);", 'src/infrastructure/config/integer-env.ts')).toEqual([]);
    expect(await lint(code, 'src/infrastructure/config/other.ts')).toEqual(['no-restricted-properties']);
  });

  it.each([
    ['parseFloat', "export const a = parseFloat('1.10');", 'no-restricted-globals'],
    ['Number.parseFloat', "export const a = Number.parseFloat('1.10');", 'no-restricted-properties'],
    ['Number()', "export const a = Number('1.10');", 'no-restricted-syntax'],
    ['toFixed', 'export const a = (1.1).toFixed(2);', 'no-restricted-properties'],
    ['unary plus', "const raw = '1';\nexport const a = +raw;", 'no-restricted-syntax'],
  ])('keeps rejecting %s in the integer-env boundary file', async (_name, code, rule) => {
    expect(await lint(code, 'src/infrastructure/config/integer-env.ts')).toEqual([rule]);
  });
});

describe('pure business lint rules', () => {
  const BUSINESS_FILE = 'src/business/wagering/policy/fixture.ts';
  const PURITY_RULES = ['no-restricted-globals', 'no-restricted-properties', 'no-restricted-syntax'];

  it.each([
    ['Math.random', 'export const a = Math.random();'],
    ['Math.round', 'export const a = Math.round(1.5);'],
    ['Math.ceil', 'export const a = Math.ceil(1.5);'],
    ['Math.trunc', 'export const a = Math.trunc(1.5);'],
    ['Math.fround', 'export const a = Math.fround(1.5);'],
    ['globalThis.Math', 'export const a = globalThis.Math.max(1, 2);'],
    ['Bun', 'export const a = Bun.randomUUIDv7();'],
    ['process', 'export const a = process.env.FOO;'],
    ["globalThis['process']", "export const a = globalThis['process'];"],
    ['Date.now', 'export const a = Date.now();'],
    ['globalThis.Date', 'export const a = globalThis.Date.now();'],
    ['new Date()', 'export const a = new Date();'],
    ['crypto.randomUUID', 'export const a = crypto.randomUUID();'],
    ['crypto.getRandomValues', 'export const a = crypto.getRandomValues(new Uint8Array(4));'],
    ['globalThis.crypto', 'export const a = globalThis.crypto.randomUUID();'],
    ['Date() without new', 'export const a = Date();'],
    ['performance.now', 'export const a = performance.now();'],
    ['performance alias', 'const p = performance;\nexport const a = p.now();'],
    ['globalThis.performance', 'export const a = globalThis.performance.now();'],
    ['alias of Date', 'const D = Date;\nexport const a = D.now();'],
    ['alias of Math', 'const M = Math;\nexport const a = M.random();'],
    ['Date passed around', 'const clocks = [Date];\nexport const a = clocks;'],
    ['destructured Math', 'const { random } = Math;\nexport const a = random();'],
  ])('rejects %s in src/business', async (_name, code) => {
    const rules = await lint(code, BUSINESS_FILE);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((rule) => PURITY_RULES.includes(rule))).toBe(true);
  });

  it.each([
    ['Math.min / Math.max', 'export const a = Math.min(Math.max(1, 2), 3);'],
    ['Math.floor', 'export const a = Math.floor(1.5);'],
    ['Math.pow / Math.abs', 'export const a = Math.pow(2, 3) + Math.abs(-1);'],
    ['new Date(value)', 'export const at = (iso: string): Date => new Date(iso);'],
    ['Date as a type and in instanceof', 'export const isDate = (value: unknown): value is Date => value instanceof Date;'],
    ['Date.UTC', 'export const epoch = Date.UTC(2026, 0, 1);'],
    ['a property named Date or Math', 'export const shape = { Date: 1, Math: 2 };\nexport const read = shape.Date + shape.Math;'],
  ])('allows %s in src/business', async (_name, code) => {
    expect(await lint(code, BUSINESS_FILE)).toEqual([]);
  });

  it('keeps the money rules active in src/business', async () => {
    expect(await lint("export const a = parseFloat('1');", BUSINESS_FILE)).toEqual(['no-restricted-globals']);
    expect(await lint("export const a = Number('1');", BUSINESS_FILE)).toEqual(['no-restricted-syntax']);
  });

  it('allows clock, randomness and process outside src/business', async () => {
    const code = [
      'export const a = Math.random() + Math.round(process.pid);',
      'export const b = Bun.version;',
      'export const c = Date.now() + new Date().getTime();',
      'export const d = crypto.randomUUID();',
    ].join('\n');
    expect(await lint(code, 'src/infrastructure/clock/fixture.ts')).toEqual([]);
  });
});
