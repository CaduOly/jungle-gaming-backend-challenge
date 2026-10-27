import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const MONEY_MESSAGE = 'Money must never pass through number. Use the Money value object (bigint minor units).';
const PURE_BUSINESS_MESSAGE = 'business/** is pure: inject clocks, randomness and configuration through ports.';

const GLOBAL_OBJECTS = ['globalThis', 'global', 'self', 'window'];
const MONEY_GLOBALS = ['parseFloat', 'parseInt', 'Number'];
const BUSINESS_GLOBALS = ['Bun', 'process'];
const BUSINESS_GLOBAL_ACCESS = ['Math', 'Date', 'crypto', ...BUSINESS_GLOBALS];
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

export const pureBusinessRules = {
  'no-restricted-globals': [
    'error',
    ...moneyRestrictedGlobals,
    ...restrictedGlobals(BUSINESS_GLOBALS, PURE_BUSINESS_MESSAGE),
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
  ],
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
    files: ['src/**/*.ts'],
    ignores: ['src/infrastructure/config/integer-env.ts'],
    rules: moneySafetyRules,
  },
  {
    files: ['src/business/**/*.ts'],
    rules: pureBusinessRules,
  },
);
