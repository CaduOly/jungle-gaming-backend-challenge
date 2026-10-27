const INFRA_ONLY_PACKAGES = [
  '@mikro-orm/[^/]+(/|$)',
  '@aws-sdk/[^/]+(/|$)',
  '@smithy/[^/]+(/|$)',
  'aws-sdk(/|$)',
  'pg(/|$|-)',
  'postgres(/|$)',
  'kysely(/|$)',
  'knex(/|$)',
  'jose(/|$)',
  'pino(/|$|-)',
  'prom-client(/|$)',
  '@opentelemetry/[^/]+(/|$)',
].join('|');

/** Top-level tests/support files that talk to the real Postgres and SQS. A new harness file must be listed here. */
const INTEGRATION_HARNESS = `^tests/support/(${[
  'assert-wallet-consistency',
  'ensure-infra-up',
  'infra-config',
  'settle',
  'sweep-test-resources',
  'test-database',
  'test-queues',
  'uuid',
].join('|')})\\.ts$`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'business-imports-only-business',
      comment: 'business/** production code is pure: no npm packages, no node builtins, no infrastructure, no test code.',
      severity: 'error',
      from: { path: '^src/business/', pathNot: '\\.spec\\.ts$' },
      to: { pathNot: '^src/business/' },
    },
    {
      name: 'business-spec-imports-only-business-or-test-doubles',
      comment:
        'business specs may also import bun:test and the test helpers in tests/support/{fakes,contracts,builders,assertions}. Those helpers are still bound by the infra package rule.',
      severity: 'error',
      from: { path: '^src/business/.+\\.spec\\.ts$' },
      to: { pathNot: ['^src/business/', '^bun:test$', '^tests/support/(fakes|contracts|builders|assertions)/'] },
    },
    {
      name: 'test-doubles-import-no-harness',
      comment:
        'fakes, contracts, builders and assertions never reach the integration harness, not even transitively (it pulls pg and the AWS SDK). uuid.ts is pure (Bun.randomUUIDv7) and stays allowed.',
      severity: 'error',
      from: { path: '^tests/support/(fakes|contracts|builders|assertions)/' },
      to: { path: '^tests/support/[^/]+\\.ts$', pathNot: '^tests/support/uuid\\.ts$' },
    },
    {
      name: 'test-support-imports-no-infrastructure',
      comment: 'tests/support (fakes, builders, assertions, harness) stands in for infrastructure and never imports src/infrastructure.',
      severity: 'error',
      from: { path: '^tests/support/' },
      to: { path: '^src/infrastructure/' },
    },
    {
      name: 'shared-kernel-imports-no-context',
      comment: 'business/shared is the shared kernel and must not depend on any bounded context.',
      severity: 'error',
      from: { path: '^src/business/shared/' },
      to: { path: '^src/business/', pathNot: '^src/business/shared/' },
    },
    {
      name: 'cross-context-only-via-public-api',
      comment:
        'A bounded context may only reach another one through entity/, enum/, event/, port/ or value-object/. business/shared is the shared kernel.',
      severity: 'error',
      from: { path: '^src/business/([^/]+)/' },
      to: {
        path: '^src/business/[^/]+/',
        pathNot: [
          '^src/business/$1/',
          '^src/business/shared/',
          '^src/business/[^/]+/(entity|enum|event|port|value-object)/',
        ],
      },
    },
    {
      name: 'nest-only-in-framework-layer',
      comment: '@nestjs/* lives only in infrastructure/framework/nest/** and main.ts.',
      severity: 'error',
      from: { pathNot: ['^src/infrastructure/framework/nest/', '^src/main\\.ts$'] },
      to: { path: '(^|/)node_modules/@nestjs/' },
    },
    {
      name: 'infra-packages-only-in-infrastructure',
      comment:
        'ORM/SQL drivers, AWS SDK, jose, pino, prom-client and OpenTelemetry only inside infrastructure/** (specs included) and in the integration harness files listed in INTEGRATION_HARNESS (real PG and SQS); never in fakes, contracts, builders or assertions.',
      severity: 'error',
      from: { pathNot: ['^src/infrastructure/', INTEGRATION_HARNESS] },
      to: { path: `(^|/)node_modules/(${INFRA_ONLY_PACKAGES})` },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
