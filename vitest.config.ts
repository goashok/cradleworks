import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Many tests drive real git repositories; on a loaded machine they pass 5 s.
    testTimeout: 20_000,
  },
});
