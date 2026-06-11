import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // No network calls allowed in tests
    testTimeout: 5_000,
    bail: 1, // Stop on first failure — fast feedback
    globals: true,
  },
});
