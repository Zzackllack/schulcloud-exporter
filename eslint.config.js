import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'archive-data/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        browser: true,
        node: true,
        es2024: true,
      },
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      react: { version: '19.3' },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        browser: true,
        node: true,
        es2024: true,
        console: true,
        process: true,
        Buffer: true,
        URL: true,
        fetch: true,
        AbortSignal: true,
        setTimeout: true,
        clearTimeout: true,
        TextEncoder: true,
        ReadableStream: true,
        Response: true,
        Headers: true,
      },
    },
    plugins: {
      react,
    },
    rules: {
      ...react.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-control-regex': 'off',
    },
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: {
      globals: {
        describe: true,
        test: true,
        before: true,
        after: true,
        beforeEach: true,
        afterEach: true,
        assert: true,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  }
);
