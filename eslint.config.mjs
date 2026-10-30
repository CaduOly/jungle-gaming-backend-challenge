import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const MONEY_MESSAGE = 'Money must never pass through number. Use the Money value object (bigint minor units).';
const PURE_BUSINESS_MESSAGE = 'business/** is pure: inject clocks, randomness and configuration through ports.';

const GLOBAL_OBJECTS = ['globalThis', 'global', 'self', 'window'];
const MONEY_GLOBALS = ['parseFloat', 'parseInt', 'Number'];
const BUSINESS_GLOBALS = ['Bun', 'process'];
const BUSINESS_GLOBAL_ACCESS = ['Math', 'Date', 'crypto', 'performance', ...BUSINESS_GLOBALS];
const BUSINESS_RESTRICTED_MEMBERS = [
  ['Math', 'random'],
  ['Math', 'round'],
  ['Math', 'ceil'],
  ['Math', 'trunc'],
  ['Math', 'fround'],
  ['Date', 'now'],
  ['crypto', 'randomUUID'],
  ['crypto', 'getRandomValues'],
];

const restrictedGlobals = (names, message) => names.map((name) => ({ name, message }));

const restrictedGlobalAccess = (names, message) =>
  GLOBAL_OBJECTS.flatMap((object) => names.map((property) => ({ object, property, message })));

const moneyRestrictedGlobals = restrictedGlobals(['parseFloat', 'parseInt'], MONEY_MESSAGE);

const moneyRestrictedProperties = [
  { object: 'Number', property: 'parseFloat', message: MONEY_MESSAGE },
  { object: 'Number', property: 'parseInt', message: MONEY_MESSAGE },
  { property: 'toFixed', message: MONEY_MESSAGE },
  { property: 'toPrecision', message: MONEY_MESSAGE },
  ...restrictedGlobalAccess(MONEY_GLOBALS, MONEY_MESSAGE),
];

const isIntegerParsing = (entry) => entry.name === 'parseInt' || (entry.object === 'Number' && entry.property === 'parseInt');

const moneyRestrictedSyntax = [
  {
    selector: [
      "Identifier[name='Number']",
      ':not(MemberExpression > Identifier.object)',
      ':not(MemberExpression[computed=false] > Identifier.property)',
      ':not(Property[computed=false] > Identifier.key)',
    ].join(''),
    message: `${MONEY_MESSAGE} Only static members such as Number.isSafeInteger are allowed.`,
  },
  {
    selector: "UnaryExpression[operator='+']",
    message: `${MONEY_MESSAGE} Unary plus coerces to number.`,
  },
  {
    selector: "UnaryExpression[operator='-'] > UnaryExpression[operator='-'].argument",
    message: `${MONEY_MESSAGE} Double negation coerces to number.`,
  },
  {
    selector: "UnaryExpression[operator='~']",
    message: `${MONEY_MESSAGE} Bitwise not coerces to a 32-bit number.`,
  },
  {
    selector: "BinaryExpression[operator='*'][left.type='Literal'][left.raw='1']",
    message: `${MONEY_MESSAGE} Multiplying by 1 coerces to number.`,
  },
  {
    selector: "BinaryExpression[operator='*'][right.type='Literal'][right.raw='1']",
    message: `${MONEY_MESSAGE} Multiplying by 1 coerces to number.`,
  },
  {
    selector: "BinaryExpression[operator='-'][right.type='Literal'][right.raw='0']",
    message: `${MONEY_MESSAGE} Subtracting 0 coerces to number.`,
  },
];

export const moneySafetyRules = {
  'no-restricted-globals': ['error', ...moneyRestrictedGlobals],
  'no-restricted-properties': ['error', ...moneyRestrictedProperties],
  'no-restricted-syntax': ['error', ...moneyRestrictedSyntax],
};

/** A fronteira de env inteiro pode fazer parse de inteiro (parseInt / Number.parseInt) e nada mais é relaxado. */
export const integerEnvRules = {
  'no-restricted-globals': ['error', ...moneyRestrictedGlobals.filter((entry) => !isIntegerParsing(entry))],
  'no-restricted-properties': ['error', ...moneyRestrictedProperties.filter((entry) => !isIntegerParsing(entry))],
  'no-restricted-syntax': ['error', ...moneyRestrictedSyntax],
};

const CLOCK_AND_MATH_ALIAS = [
  "Identifier[name=/^(Date|Math)$/]",
  ':not(MemberExpression > Identifier.object)',
  ':not(NewExpression > Identifier.callee)',
  ':not(MemberExpression[computed=false] > Identifier.property)',
  ':not(Property[computed=false] > Identifier.key)',
  ':not(TSTypeReference > Identifier.typeName)',
  ':not(TSQualifiedName > Identifier)',
  ':not(TSTypeQuery > Identifier.exprName)',
  ':not(BinaryExpression[operator="instanceof"] > Identifier.right)',
].join('');

export const pureBusinessRules = {
  'no-restricted-globals': [
    'error',
    ...moneyRestrictedGlobals,
    ...restrictedGlobals([...BUSINESS_GLOBALS, 'performance'], PURE_BUSINESS_MESSAGE),
  ],
  'no-restricted-properties': [
    'error',
    ...moneyRestrictedProperties,
    ...restrictedGlobalAccess(BUSINESS_GLOBAL_ACCESS, PURE_BUSINESS_MESSAGE),
    ...BUSINESS_RESTRICTED_MEMBERS.map(([object, property]) => ({ object, property, message: PURE_BUSINESS_MESSAGE })),
  ],
  'no-restricted-syntax': [
    'error',
    ...moneyRestrictedSyntax,
    {
      selector: "NewExpression[callee.type='Identifier'][callee.name='Date'][arguments.length=0]",
      message: `${PURE_BUSINESS_MESSAGE} new Date() reads the wall clock; use IClock.`,
    },
    {
      selector: "CallExpression[callee.type='Identifier'][callee.name='Date']",
      message: `${PURE_BUSINESS_MESSAGE} Date() reads the wall clock; use IClock.`,
    },
    {
      selector: CLOCK_AND_MATH_ALIAS,
      message: `${PURE_BUSINESS_MESSAGE} Date and Math may only be used directly (Date.UTC, new Date(value), Math.max), never aliased.`,
    },
  ],
};

/**
 * Código de negócio de produção nunca nega um valor: Money não tem negativo e contador não precisa. Spec pode
 * (por exemplo offset `-count` num relógio de teste), então essa regra não entra nas regras de money compartilhadas.
 */
const UNARY_MINUS_ON_VALUE = {
  selector: "UnaryExpression[operator='-']:not([argument.type='Literal'])",
  message: `${MONEY_MESSAGE} Unary minus on a value coerces it to number; Money is never negative.`,
};

export const productionBusinessRules = {
  ...pureBusinessRules,
  'no-restricted-syntax': [...pureBusinessRules['no-restricted-syntax'], UNARY_MINUS_ON_VALUE],
};

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'tests/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { module: 'writable', require: 'readonly' } },
  },
  {
    files: ['tests/load/k6/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', open: 'readonly' },
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: moneySafetyRules,
  },
  {
    files: ['src/infrastructure/config/integer-env.ts'],
    rules: integerEnvRules,
  },
  {
    files: ['src/business/**/*.ts'],
    rules: pureBusinessRules,
  },
  {
    files: ['src/business/**/*.ts'],
    ignores: ['src/business/**/*.spec.ts'],
    rules: productionBusinessRules,
  },
);
