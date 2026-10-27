import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { cruise, type IConfiguration, type ICruiseResult } from 'dependency-cruiser';

const projectRoot = resolve(import.meta.dir, '../..');
const fixturesRoot = resolve(import.meta.dir, '../fixtures/arch');
const config = createRequire(import.meta.url)(resolve(projectRoot, '.dependency-cruiser.cjs')) as IConfiguration;

const violatedRules = async (baseDir: string): Promise<string[]> => {
  const { tsConfig: _tsConfig, ...options } = config.options ?? {};
  const roots = ['src', 'tests/support'].filter((root) => existsSync(resolve(baseDir, root)));
  const reporting = await cruise(roots, {
    ...options,
    baseDir,
    validate: true,
    ruleSet: { forbidden: config.forbidden ?? [] },
  });
  const result = reporting.output as ICruiseResult;
  return [...new Set(result.summary.violations.map((violation) => violation.rule.name))].sort();
};

const infraPackagePattern = (): RegExp => {
  const rule = config.forbidden?.find((candidate) => candidate.name === 'infra-packages-only-in-infrastructure');
  const path = rule !== undefined && 'to' in rule ? rule.to.path : undefined;
  if (typeof path !== 'string') throw new Error('infra-packages-only-in-infrastructure rule not found');
  return new RegExp(path);
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
    ['infra-package-family-outside-infrastructure', ['infra-packages-only-in-infrastructure']],
    ['shared-imports-context', ['shared-kernel-imports-no-context']],
    [
      'business-spec-imports-infra-package',
      ['business-spec-imports-only-business-or-test-doubles', 'infra-packages-only-in-infrastructure'],
    ],
    ['business-imports-test-support', ['business-imports-only-business']],
    ['business-spec-imports-other-test-support', ['business-spec-imports-only-business-or-test-doubles']],
    ['fake-imports-infra-package', ['infra-packages-only-in-infrastructure']],
    ['support-imports-infrastructure', ['test-support-imports-no-infrastructure']],
    ['fake-imports-harness', ['test-doubles-import-no-harness']],
    ['unlisted-support-file-imports-infra-package', ['infra-packages-only-in-infrastructure']],
  ])('flags %s', async (scenario, expected) => {
    expect(await violatedRules(resolve(fixturesRoot, scenario))).toEqual(expected);
  });

  it('lets the top-level integration harness of tests/support use pg and the AWS SDK', async () => {
    expect(await violatedRules(resolve(fixturesRoot, 'support-harness-imports-infra-package'))).toEqual([]);
  });

  it.each([
    'node_modules/@mikro-orm/core/index.js',
    'node_modules/@aws-sdk/client-sqs/dist-cjs/index.js',
    'node_modules/aws-sdk/lib/aws.js',
    'node_modules/pg/esm/index.mjs',
    'node_modules/pg-cursor/index.js',
    'node_modules/postgres/src/index.js',
    'node_modules/kysely/dist/esm/index.js',
    'node_modules/knex/knex.js',
    'node_modules/jose/dist/node/esm/index.js',
    'node_modules/pino/pino.js',
    'node_modules/pino-pretty/index.js',
    'node_modules/pino-http/logger.js',
    'node_modules/prom-client/index.js',
    'node_modules/@opentelemetry/api/build/src/index.js',
    'node_modules/.bun/pino@9.0.0/node_modules/pino/pino.js',
  ])('treats %s as an infrastructure-only package', (path) => {
    expect(infraPackagePattern().test(path)).toBe(true);
  });

  it.each([
    'node_modules/@nestjs/common/index.js',
    'node_modules/rxjs/dist/esm/index.js',
    'node_modules/pgp-utils/index.js',
    'node_modules/postgresql-client/index.js',
    'node_modules/joseph/index.js',
    'node_modules/pinot/index.js',
    'src/business/pino/fixture.ts',
  ])('does not treat %s as an infrastructure-only package', (path) => {
    expect(infraPackagePattern().test(path)).toBe(false);
  });
});
