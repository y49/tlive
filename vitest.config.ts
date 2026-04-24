import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 10000,
  },
});
