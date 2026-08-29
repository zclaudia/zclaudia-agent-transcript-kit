import { defineConfig } from 'vitest/config';

// Component tests only. The layer-1/2 logic is covered by tests/run.ts, which
// runs on plain node with no framework — the package has no runtime
// dependencies, and testing it that way keeps proving so.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/react/**/*.test.tsx'],
    setupFiles: ['tests/react/setup.ts'],
  },
});
