import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/worker/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'worker/src/**/*.ts'],
      exclude: ['src/main.ts', 'src/post.ts'],
    },
  },
});
