import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importsOf, readSources, resolveSpecifier, violations } from './support/arch'

const root = join(__dirname, '..')

describe('architecture: layer rules (docs/architecture.md)', () => {
  it('the real source tree respects every layer rule', () => {
    const sources = readSources(root)
    expect(Object.keys(sources).length).toBeGreaterThan(50)
    expect(violations(sources)).toEqual([])
  })

  // A rule that has never been seen to fail proves nothing (constitution III).
  it('flags each kind of forbidden import', () => {
    const files = {
      'src/shared/a.ts': "import { x } from '../coordinator/agent'",
      'src/renderer/src/b.tsx': "import fs from 'node:fs'\nimport { audit } from '../../shared/audit'\nimport('../../main/guard')",
      'src/coordinator/tools/c.ts': "import { app } from 'electron'",
      'src/coordinator/index.ts': "import type { MessagePortMain } from 'electron'",
      'src/main/d.ts': "export { y } from '../renderer/src/App'"
    }
    expect(violations(files).map((v) => v.split(': ')[0])).toEqual([
      'src/shared/a.ts imports ../coordinator/agent',
      'src/renderer/src/b.tsx imports node:fs',
      'src/renderer/src/b.tsx imports ../../shared/audit',
      'src/renderer/src/b.tsx imports ../../main/guard',
      'src/coordinator/tools/c.ts imports electron',
      'src/main/d.ts imports ../renderer/src/App'
    ])
  })

  it('allows what the layers are for', () => {
    const files = {
      'src/renderer/src/a.tsx': "import type { Settings } from '../../shared/types'\nimport React from 'react'",
      'src/coordinator/agent.ts': "import { defaultSettings } from '../shared/defaults'",
      'src/main/index.ts': "import { app } from 'electron'\nimport { newCommands } from './guard'"
    }
    expect(violations(files)).toEqual([])
  })

  it('reads static, dynamic and re-export imports and resolves relative paths', () => {
    expect(importsOf("import a from 'a'\nimport 'side'\nconst m = await import('dyn')\nexport * from './re'")).toEqual(['a', 'side', 'dyn', './re'])
    expect(resolveSpecifier('src/coordinator/tools/x.ts', '../../shared/types')).toBe('src/shared/types')
    expect(resolveSpecifier('src/a.ts', 'zod/v4')).toBe('zod/v4')
  })
})
