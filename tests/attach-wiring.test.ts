import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Spec 030: main/index.ts needs Electron and cannot be run here, so the audit line of a refusal is checked as text.
const main = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')

describe('shell:openPath refusals (spec 030 AC-5.7)', () => {
  it('AC-5.7 (030) the refusal for a stored attachment audits no file name', () => {
    const start = main.indexOf('if (touchesAttachmentStore(path, attachmentRoot()))')
    expect(start).toBeGreaterThan(0)
    const branch = main.slice(start, main.indexOf('return mainError', start))
    expect(branch).toContain("action: 'shell.openPath'")
    expect(branch).not.toContain('target')
    expect(branch).not.toContain('basename')
  })
})
