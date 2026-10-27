const INFRA_ONLY_PACKAGES = [
  '@mikro-orm',
  '@aws-sdk',
  '@smithy',
  'pg',
  'jose',
  'pino',
  'prom-client',
  '@opentelemetry',
].join('|');

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'business-imports-only-business',
      comment: 'business/** is pure: no npm packages, no node builtins, no infrastructure.',
      severity: 'error',
      from: { path: '^src/business/' },
      to: { pathNot: '^src/business/' },
    },
    {
      name: 'cross-context-only-via-public-api',
      comment:
        'A bounded context may only reach another one through entity/, event/, port/ or value-object/. business/shared is the shared kernel.',
      severity: 'error',
      from: { path: '^src/business/([^/]+)/' },
      to: {
        path: '^src/business/[^/]+/',
        pathNot: [
          '^src/business/$1/',
          '^src/business/shared/',
          '^src/business/[^/]+/(entity|event|port|value-object)/',
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
      comment: 'ORM, AWS SDK, jose, pino, prom-client and OpenTelemetry only inside infrastructure/**.',
      severity: 'error',
      from: { pathNot: '^src/infrastructure/' },
      to: { path: `(^|/)node_modules/(${INFRA_ONLY_PACKAGES})(/|$)` },
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
    exclude: { path: '\\.spec\\.ts$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
