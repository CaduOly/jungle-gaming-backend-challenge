import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { cruise, type IConfiguration, type ICruiseResult } from 'dependency-cruiser';

const projectRoot = resolve(import.meta.dir, '../..');
const fixturesRoot = resolve(import.meta.dir, '../fixtures/arch');
const config = createRequire(import.meta.url)(resolve(projectRoot, '.dependency-cruiser.cjs')) as IConfiguration;

const violatedRules = async (baseDir: string): Promise<string[]> => {
  const { tsConfig: _tsConfig, ...options } = config.options ?? {};
  const reporting = await cruise(['src'], {
    ...options,
    baseDir,
    validate: true,
    ruleSet: { forbidden: config.forbidden ?? [] },
  });
  const result = reporting.output as ICruiseResult;
  return [...new Set(result.summary.violations.map((violation) => violation.rule.name))].sort();
};

describe('architecture rules (dependency-cruiser)', () => {
  it('the real src/ has no violations', async () => {
    expect(await violatedRules(projectRoot)).toEqual([]);
  });

  it('accepts a layout that follows every rule', async () => {
    expect(await violatedRules(resolve(fixturesRoot, 'clean'))).toEqual([]);
  });

  it.each([
    ['business-imports-infrastructure', ['business-imports-only-business']],
    ['business-imports-builtin', ['business-imports-only-business']],
    ['cross-context-use-case', ['cross-context-only-via-public-api']],
    ['nest-outside-framework', ['nest-only-in-framework-layer']],
    ['infra-package-outside-infrastructure', ['infra-packages-only-in-infrastructure']],
  ])('flags %s', async (scenario, expected) => {
    expect(await violatedRules(resolve(fixturesRoot, scenario))).toEqual(expected);
  });
});
