import js from '@eslint/js';
import globals from 'globals';
import security from 'eslint-plugin-security';

export default [
  { ignores: ['node_modules/', '.aws-sam/', 'coverage/'] },
  js.configs.recommended,
  security.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest', // JSON import attributes (`with { type: 'json' }`) for config/

      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      eqeqeq: ['error', 'always'],
      'require-await': 'error',
    },
  },
  {
    // Widgets run in the browser inside the app page: no Node globals, no HTML injection.
    files: ['widgets/**/*.js', 'demo/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    rules: {
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Use textContent or DOM methods; record data must never be parsed as HTML.' },
        { property: 'outerHTML', message: 'Use DOM methods instead.' },
        { property: 'insertAdjacentHTML', message: 'Use DOM methods instead.' },
        { property: 'srcdoc', message: 'An iframe srcdoc is parsed as HTML.' },
        { property: 'setHTMLUnsafe', message: 'Use textContent or DOM methods.' },
        { property: 'createContextualFragment', message: 'Use textContent or DOM methods.' },
        { property: 'parseFromString', message: 'DOMParser output is HTML from text; build elements instead.' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.object.name='document'][callee.property.name='write']", message: 'document.write is not allowed.' },
      ],
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-object-injection': 'off',
      'require-await': 'off', // async stubs (`async () => value`) stand in for real async calls
    },
  },
];
