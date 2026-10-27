import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const MONEY_MESSAGE = 'Money must never pass through number. Use the Money value object (bigint minor units).';

export const moneySafetyRules = {
  'no-restricted-globals': [
    'error',
    { name: 'parseFloat', message: MONEY_MESSAGE },
    { name: 'parseInt', message: MONEY_MESSAGE },
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Number', property: 'parseFloat', message: MONEY_MESSAGE },
    { object: 'Number', property: 'parseInt', message: MONEY_MESSAGE },
    { property: 'toFixed', message: MONEY_MESSAGE },
  ],
  'no-restricted-syntax': [
    'error',
    { selector: "CallExpression[callee.type='Identifier'][callee.name='Number']", message: MONEY_MESSAGE },
    { selector: "NewExpression[callee.type='Identifier'][callee.name='Number']", message: MONEY_MESSAGE },
    { selector: "CallExpression[callee.type='Identifier'][callee.name='parseFloat']", message: MONEY_MESSAGE },
    { selector: "CallExpression[callee.type='Identifier'][callee.name='parseInt']", message: MONEY_MESSAGE },
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
    ignores: ['src/infrastructure/config/**'],
    rules: moneySafetyRules,
  },
);
