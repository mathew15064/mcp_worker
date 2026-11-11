import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'worker/node_modules/**',
      'worker/bin/**',
      'reports/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  {
    files: [
      'src/**/*.ts',
      'worker/**/*.ts',
      'scripts/**/*.ts',
      'tests/**/*.ts',
      'playwright.config.ts',
    ],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
