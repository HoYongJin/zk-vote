import { defineConfig } from 'vitest/config';

// Root (repo-level) test runner for the pure-logic helper/migration suites.
// The frontend has its own vitest setup; this one is node-only.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
