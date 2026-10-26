/**
 * Vitest config for the three Cordis plugins.
 *
 * The repository root config is owned by the Lead; this file only exists so the
 * plugin suites can be run from the repository root:
 *
 *   npx vitest run --config plugins/vitest.config.ts
 *   npx vitest run --dir plugins            # root config + plugin tests
 *
 * `root` is pinned to this directory so both invocations collect the same files.
 * `dist/` is excluded from collection (only `src/**\/*.test.ts` runs); the smoke
 * tests import `dist/index.js` explicitly, so a build must precede a test run.
 */
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    // The approval round trip polls the control channel at 100 ms.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
