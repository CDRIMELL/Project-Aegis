import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const PURE_CORE_MESSAGE =
  'The domain and simulation packages must stay free of UI, platform and persistence code (ADR 0001, 0002).';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/target/**',
      'apps/desktop/src-tauri/gen/**',
      'packages/db/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}', 'packages/ui/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // Determinism and purity guard for the simulation core.
    files: ['packages/domain/src/**/*.ts', 'packages/sim/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-*',
                '@tauri-apps/*',
                'drizzle-orm',
                'drizzle-orm/*',
                'zustand',
                'node:*',
                '@aegis/db',
                '@aegis/db/*',
                '@aegis/ui',
                '@aegis/ui/*',
              ],
              message: PURE_CORE_MESSAGE,
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'performance', 'setTimeout', 'setInterval', 'fetch'].map(
          (name) => ({ name, message: PURE_CORE_MESSAGE }),
        ),
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use a named Rng stream so the simulation stays deterministic (ADR 0006).',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'The simulation core never reads the wall clock (ADR 0005).',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'The simulation core never reads the wall clock (ADR 0005).',
        },
      ],
    },
  },
  {
    // The domain is the bottom layer: it may not depend on any other AEGIS package.
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@aegis/*',
                'react',
                'react-*',
                '@tauri-apps/*',
                'drizzle-orm',
                'drizzle-orm/*',
                'zustand',
                'node:*',
              ],
              message: PURE_CORE_MESSAGE,
            },
          ],
        },
      ],
    },
  },
);
