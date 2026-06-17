import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Errors
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // Code quality
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-throw-literal': 'error',

      // Off — handled by Prettier
      'indent': 'off',
      'semi': 'off',
      'quotes': 'off',
    },
  },
  {
    // Production code routes diagnostics through the central `logger`
    // (src/system/logger.ts → "SideCar" output channel), never the dev
    // console. Tests and the eval/integration harness under src/test/ may use
    // console freely (they run outside the extension host).
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/test/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
];
