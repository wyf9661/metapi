// ESLint flat config — lightweight syntax-only checks.
// Type correctness is enforced by `tsc` (typecheck:* scripts). TS syntax is
// parsed with @babel/eslint-parser because typescript-eslint does not yet
// support the repo's TypeScript 7.x (peer range caps at <6.1.0); Babel only
// strips types, so no type-aware rules here.
//
// We deliberately do NOT enable js.configs.recommended: its code-path rules
// (getter-return, no-dupe-args, ...) crash on Babel's TS transform. Only
// parser-independent safety rules are listed.
import babelParser from '@babel/eslint-parser';

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'release/**',
      'src/server/db/generated/**',
      'docs/.vitepress/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: ['@babel/preset-typescript'],
        },
      },
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // allow empty catch blocks only when they are intentional; flag others
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `return resolve(...)` inside promise executors is an accepted idiom;
      // the value is ignored by the Promise constructor, so skip this rule
      'no-promise-executor-return': 'off',
      // require braces for control statements (readability)
      curly: 'off',
      // single quotes (repo style), no semicolon enforcement
      quotes: ['error', 'single', { avoidEscape: true }],
      'no-debugger': 'warn',
      // disallow `new` for side-effect-only constructors
      'no-new': 'error',
      // `while ((m = re.exec(x)) !== null)` regex loops are intentional
      'no-cond-assign': 'off',
    },
  },
];
