import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts', 'test/unit/**/*.test.tsx', 'test/performance/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
