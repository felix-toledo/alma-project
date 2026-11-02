import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // office.test.ts takes 3s alone but timed out at 30s when every worker was importing exceljs under coverage.
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      // Logic lives in these three; the renderer is verified by typecheck + lint (see docs/architecture.md).
      include: ['src/coordinator/**/*.ts', 'src/shared/**/*.ts', 'src/main/**/*.ts'],
      exclude: ['**/*.d.ts', 'src/coordinator/index.ts', 'src/main/index.ts', 'src/coordinator/**/*-worker.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      // Ratchet, measured at lines 53.8 / statements 50.3 / functions 49.0 / branches 42.0. Raise when coverage
      // improves; never lower (constitution II). A drop means the new code arrived without tests.
      thresholds: { lines: 53, statements: 50, functions: 48, branches: 41 }
    }
  }
})
