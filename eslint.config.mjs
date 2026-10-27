import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const MONEY_MESSAGE = 'Money must never pass through number. Use the Money value object (bigint minor units).';
const PURE_BUSINESS_MESSAGE = 'business/** is pure: inject clocks, randomness and configuration through ports.';

const GLOBAL_OBJECTS = ['globalThis', 'global', 'self', 'window'];
const MONEY_GLOBALS = ['parseFloat', 'parseInt', 'Number'];
const BUSINESS_GLOBALS = ['Math', 'Bun', 'process'];

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
];

export const moneySafetyRules = {
  'no-restricted-globals': ['error', ...moneyRestrictedGlobals],
  'no-restricted-properties': ['error', ...moneyRestrictedProperties],
  'no-restricted-syntax': ['error', ...moneyRestrictedSyntax],
  'no-implicit-coercion': ['error', { boolean: false, string: false, number: true, disallowTemplateShorthand: false }],
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
    ...restrictedGlobalAccess(BUSINESS_GLOBALS, PURE_BUSINESS_MESSAGE),
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
