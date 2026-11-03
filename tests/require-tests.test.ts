import { describe, expect, it } from 'vitest'
import { testGap } from '../scripts/require-tests.mts'

describe('pseudo-TDD gate', () => {
  it('rejects logic changes without tests', () => {
    expect(testGap(['src/coordinator/agent.ts'], '')).toContain('src/coordinator/agent.ts')
    expect(testGap(['src/shared/types.ts', 'README.md'], 'feat: x')).not.toBeNull()
  })

  it('accepts logic with a test, test-only, UI-only, docs-only and entrypoints', () => {
    expect(testGap(['src/coordinator/agent.ts', 'tests/agent.test.ts'], '')).toBeNull()
    expect(testGap(['tests/agent.test.ts'], '')).toBeNull()
    expect(testGap(['src/renderer/src/App.tsx'], '')).toBeNull()
    expect(testGap(['docs/pipeline.md'], '')).toBeNull()
    expect(testGap(['src/main/index.ts', 'src/coordinator/index.ts', 'src/preload/api.d.ts'], '')).toBeNull()
  })

  it('needs a real reason to waive', () => {
    expect(testGap(['src/main/guard.ts'], 'refactor: rename [no-tests: pure rename, covered by guard.test]')).toBeNull()
    expect(testGap(['src/main/guard.ts'], 'chore [no-tests]')).not.toBeNull()
    expect(testGap(['src/main/guard.ts'], 'chore [no-tests: ]')).not.toBeNull()
  })
})
