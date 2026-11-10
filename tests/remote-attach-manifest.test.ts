import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('the protected manifest and spec 031 (T44)', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, 'support', 'remote-protected.json'), 'utf8')) as Record<string, string>

  it('AC-9.4 (031) uploads.ts is in the manifest', () => {
    expect(Object.keys(manifest)).toContain('src/coordinator/channels/remote/uploads.ts')
  })
})
