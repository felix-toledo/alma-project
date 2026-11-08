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

describe('architecture: remote access zones (spec 026 T1)', () => {
  it('flags a phone client that reaches outside itself and the remote contracts', () => {
    const files = {
      'src/remote-client/a.tsx':
        "import { x } from '../renderer/src/x'\nimport fs from 'node:fs'\nimport { audit } from '../shared/audit'\nimport type { Settings } from '../shared/types'"
    }
    expect(violations(files).map((v) => v.split(': ')[0])).toEqual([
      'src/remote-client/a.tsx imports ../renderer/src/x',
      'src/remote-client/a.tsx imports node:fs',
      'src/remote-client/a.tsx imports ../shared/audit',
      'src/remote-client/a.tsx imports ../shared/types'
    ])
  })

  it('allows the phone client itself, the remote contracts and bare packages', () => {
    const files = {
      'src/remote-client/a.tsx':
        "import { ROUTES } from '../shared/remote/api'\nimport { Button } from './ui/Button'\nimport React from 'react'"
    }
    expect(violations(files)).toEqual([])
  })

  it('flags anyone importing the phone client', () => {
    const files = {
      'src/renderer/src/b.tsx': "import App from '../../remote-client/App'",
      'src/coordinator/agent.ts': "import { t } from '../remote-client/i18n'"
    }
    expect(violations(files).map((v) => v.split(': ')[0])).toEqual([
      'src/renderer/src/b.tsx imports ../../remote-client/App',
      'src/coordinator/agent.ts imports ../remote-client/i18n'
    ])
  })

  it('flags node-only imports in the shared remote contracts', () => {
    const files = {
      'src/shared/remote/c.ts':
        "import { createHash } from 'node:crypto'\nimport { app } from 'electron'\nimport { audit } from '../audit'"
    }
    expect(violations(files).map((v) => v.split(': ')[0])).toEqual([
      'src/shared/remote/c.ts imports node:crypto',
      'src/shared/remote/c.ts imports electron',
      'src/shared/remote/c.ts imports ../audit'
    ])
  })

  it('flags shared imports of the phone client', () => {
    const files = { 'src/shared/d.ts': "import { x } from '../remote-client/x'" }
    const found = violations(files)
    expect(found).toHaveLength(2)
    expect(found.every((v) => v.startsWith('src/shared/d.ts imports ../remote-client/x'))).toBe(true)
  })
})

describe('architecture: remote vault and conversations (spec 028 T60)', () => {
  const PURE = ['notes', 'threads', 'runs', 'thread-view', 'quiet']
  const at = (name: string): string => `src/coordinator/channels/remote/${name}.ts`

  it('AC-7.4 (028) the notes, threads, runs, thread-view and quiet modules reach no disk, network, agent or entry point', () => {
    for (const name of PURE) {
      for (const specifier of ['node:fs', 'node:fs/promises', 'node:http', 'node:https', 'node:net', 'node:tls', 'node:dns', 'node:child_process', '../../agent', '../../index']) {
        expect(violations({ [at(name)]: `import x from '${specifier}'` }), `${name} ${specifier}`).toHaveLength(1)
      }
    }
  })

  it('AC-7.4 (028) the same modules may use the contracts, the pure vault logic and the tool error type', () => {
    const source = [
      "import { REMOTE_LIMITS } from '../../../shared/remote/api'",
      "import { listFolder } from '../../../shared/vault/paths'",
      "import { isCompanyThread } from '../../../shared/threads'",
      "import { ToolError } from '../../tools/types'",
      "import { refusalResponse } from './transport'"
    ].join('\n')
    for (const name of PURE) expect(violations({ [at(name)]: source }), name).toEqual([])
    // Only these modules are held to it: the store and the transports do touch disk and network.
    expect(violations({ [at('store')]: "import { readFile } from 'node:fs/promises'", [at('tailscale-transport')]: "import { request } from 'node:https'" })).toEqual([])
  })

  it('AC-7.5 (028) the shared vault logic and thread helpers stay browser-safe', () => {
    const files = {
      'src/shared/vault/paths.ts': "import { join } from 'node:path'\nimport { audit } from '../audit'",
      'src/shared/threads.ts': "import { app } from 'electron'\nimport { readFileSync } from 'node:fs'"
    }
    expect(violations(files).map((v) => v.split(': ')[0])).toEqual([
      'src/shared/vault/paths.ts imports node:path',
      'src/shared/vault/paths.ts imports ../audit',
      'src/shared/threads.ts imports electron',
      'src/shared/threads.ts imports node:fs'
    ])
    expect(violations({ 'src/shared/vault/paths.ts': "import type { Language } from '../i18n/language'\nimport type { VaultEntry } from '../types'" })).toEqual([])
  })

  it('AC-7.4 (028) the phone client may import the pure vault logic besides the remote contracts, and nothing else widens', () => {
    expect(violations({ 'src/remote-client/lib/markdown.ts': "import { resolveVaultAsset } from '../../shared/vault/paths'\nimport { ROUTES } from '../../shared/remote/api'" })).toEqual([])
    const files = {
      'src/remote-client/a.tsx': [
        "import { isCompanyThread } from '../shared/threads'",
        "import { audit } from '../shared/audit'",
        "import type { Settings } from '../shared/types'",
        "import { t } from '../shared/i18n/en'",
        "import { x } from '../shared/vaultish'",
        "import { y } from '../shared/vault'",
        "import { z } from '../coordinator/channels/remote/notes'"
      ].join('\n')
    }
    expect(violations(files).map((v) => v.split(': ')[0])).toEqual([
      'src/remote-client/a.tsx imports ../shared/threads',
      'src/remote-client/a.tsx imports ../shared/audit',
      'src/remote-client/a.tsx imports ../shared/types',
      'src/remote-client/a.tsx imports ../shared/i18n/en',
      'src/remote-client/a.tsx imports ../shared/vaultish',
      'src/remote-client/a.tsx imports ../shared/vault',
      'src/remote-client/a.tsx imports ../coordinator/channels/remote/notes'
    ])
  })
})
