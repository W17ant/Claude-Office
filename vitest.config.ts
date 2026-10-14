import { defineConfig } from 'vitest/config'

// Server/hook tests only for now — they run in plain Node. Frontend (jsdom)
// tests from TEST_PLAN.md can be added as a second project later.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // One worker per file: each file imports its own copy of server/index.js
    // with its own AGENT_OFFICE_HOME temp dir (see tests/helpers.ts).
    pool: 'forks',
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
