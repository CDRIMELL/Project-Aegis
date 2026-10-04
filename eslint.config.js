import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * `Math` functions whose last digit differs between engines and engine versions. The simulation
 * core uses the deterministic versions in `packages/domain/src/math.ts` instead (ADR 0020).
 * Add, subtract, multiply, divide and `Math.sqrt` are exact everywhere and stay allowed.
 */
const ENGINE_DEPENDENT_MATH = [
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'exp',
  'expm1',
  'log',
  'log2',
  'log10',
  'log1p',
  'pow',
  'cbrt',
  'hypot',
];
const ENGINE_DEPENDENT_MESSAGE =
  'This is not computed identically by every engine. Use packages/domain/src/math.ts (ADR 0020).';

const STABLE_SELECTOR_MESSAGE =
  'A store selector must not build a new array or object: select the stored value and derive the rest in useMemo.';

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
      // A store selector must return the same reference while the store is unchanged. One that
      // builds a new array or object makes React re-render without end.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.name=/^use[A-Z]\\w*Store$/] > ArrowFunctionExpression :matches(ArrayExpression, ObjectExpression)',
          message: STABLE_SELECTOR_MESSAGE,
        },
        {
          selector:
            'CallExpression[callee.name=/^use[A-Z]\\w*Store$/] > ArrowFunctionExpression CallExpression[callee.property.name=/^(map|filter|slice|concat|flatMap)$/]',
          message: STABLE_SELECTOR_MESSAGE,
        },
      ],
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
        ...ENGINE_DEPENDENT_MATH.map((property) => ({
          object: 'Math',
          property,
          message: ENGINE_DEPENDENT_MESSAGE,
        })),
        ...['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].map((property) => ({
          property,
          message:
            'Locale formatting depends on the engine. Text stored with the world must not (ADR 0020).',
        })),
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'The simulation core never reads the wall clock (ADR 0005).',
        },
        {
          selector: "BinaryExpression[operator='**']",
          message: ENGINE_DEPENDENT_MESSAGE,
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
  {
    // Tests check the deterministic functions against the engine's own, so they may call both.
    // Everything else about the simulation core still applies to them.
    files: ['packages/domain/src/**/*.test.ts', 'packages/sim/src/**/*.test.ts'],
    rules: {
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
);
