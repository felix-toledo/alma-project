import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Spec 030: the entry files (coordinator/index.ts, main/index.ts) need Electron and cannot be run here, so these tests
// read them as text to check the wiring the behavior tests above rely on. They are inspection, not behavior: a rename
// breaks them on purpose so the wiring gets looked at again.

const read = (...parts: string[]): string => readFileSync(join(__dirname, '..', ...parts), 'utf8')
const coordinator = read('src', 'coordinator', 'index.ts')
const main = read('src', 'main', 'index.ts')
const at = (source: string, needle: string): number => {
  const index = source.indexOf(needle)
  expect(index, `"${needle}" is in the source`).toBeGreaterThanOrEqual(0)
  return index
}

describe('AC-5.4 / AC-6.2 / AC-6.7 (030 verify) coordinator wiring', () => {
  it('AC-5.4 (030 verify) the thread store deletes attachment files when it deletes a conversation', () => {
    expect(coordinator).toContain('new ThreadStore(message.dataDir, () => settings.language, (id) => attachments.deleteForThread(id))')
  })

  it('AC-5.4 (030 verify) retention and erase both delete conversations through the thread store', () => {
    expect(coordinator).toMatch(/for \(const thread of expired\) store\.delete\(thread\.id\)/)
    expect(coordinator).toMatch(/for \(const thread of threads\) \{[^}]*store\.delete\(thread\.id\)[^}]*\}\s*erasePersonalFiles\(inboxDir\(\)\)/s)
  })

  it('AC-6.2 (030 verify) the sweep starts with the coordinator and skips every conversation that has a run', () => {
    expect(coordinator).toContain('scheduleSweep(sweepAttachments)')
    const sweep = coordinator.slice(at(coordinator, 'function sweepAttachments'))
    expect(sweep.slice(0, sweep.indexOf('\n}\n'))).toContain('new Set(runs.keys())')
    expect(sweep.slice(0, sweep.indexOf('\n}\n'))).toContain('.lastOpenedAt')
  })

  it('AC-1.3 (030 verify) a send that cannot start (a run is active, no agent, bad attachments) fails before the thread is changed', () => {
    const busy = at(coordinator, 'if (runs.has(threadId)) throw')
    const noAgent = at(coordinator, "throw new Error(translate(settings.language, 'error.noAgents'))")
    const compose = at(coordinator, 'composeUserMessage({')
    const push = at(coordinator, 'thread.messages.push(userMessage)')
    const opened = at(coordinator, 'store.markOpened(thread.id, userMessage.ts)')
    const running = at(coordinator, 'runs.set(threadId, controller)')
    expect(busy).toBeLessThan(compose)
    expect(noAgent).toBeLessThan(compose)
    expect(compose).toBeLessThan(push)
    expect(push).toBeLessThan(running)
    expect(opened).toBeGreaterThan(push)
    expect(opened).toBeLessThan(running)
  })

  it('AC-6.7 (030 verify) opening the conversation only counts for a message from the person; routine, house and company runs are unattended', () => {
    expect(coordinator).toContain('if (countsAsOpened(options)) store.markOpened(')
    const unattended = coordinator.match(/startRun\([^\n]*unattended: true/g) ?? []
    expect(unattended).toHaveLength(3)
    // every other caller (Telegram, WhatsApp, voice, chat) passes no options, so it counts as opened
    const plain = coordinator.match(/startRun\(threadId, text\)\.done/g) ?? []
    expect(plain.length).toBeGreaterThanOrEqual(4)
    // the phone's channel passes only the attachment ids (spec 031), which does not make the run unattended
    expect(coordinator).toContain('startRun(threadId, text, { attachments: attachmentIds }).done')
  })

  it('AC-1.3 (030 verify) chat.send hands the ids to the run and nothing else about the files', () => {
    expect(coordinator).toContain('startRun(request.threadId, request.text, { attachments: request.attachments })')
  })

  it('AC-4.7 (030 verify) the run context carries the store, so sub-agents (which inherit the context) can read by id', () => {
    const agent = read('src', 'coordinator', 'agent.ts')
    expect(agent).toMatch(/attachments: ctx\.attachments,/)
    expect(coordinator).toMatch(/inboxDir: inboxDir\(\),\s*attachments,/)
  })
})

describe('AC-2.4 / AC-7.5 (030 verify) main wiring', () => {
  it('AC-2.4 (030 verify) the page reads and lists only granted paths', () => {
    expect(main).toContain("handle('attach:inspect', (_event, path: unknown) => inspectGranted(path as string, attachGrants))")
    expect(main).toContain("handle('attach:read', (_event, path: unknown) => readGranted(path as string, attachGrants))")
    expect(main).toMatch(/ipcMain\.on\('attach:grant', \(event, path: unknown\) => \{\s*if \(isTrusted\(event\) && typeof path === 'string'\)/)
  })

  it('AC-1.8 (030 verify) the picker allows several files and a cancelled dialog yields none', () => {
    expect(main).toContain("properties: ['openFile' as const, 'multiSelections' as const]")
    expect(main).toContain('result.canceled ? [] : result.filePaths')
  })

  it('AC-7.5 (030 verify) opening a stored attachment goes through the real-path guard, and the generic open refuses the store', () => {
    expect(main).toContain('openableAttachment(request.path, attachmentRoot())')
    const generic = main.slice(at(main, "handle('shell:openPath'"))
    expect(generic.indexOf('touchesAttachmentStore(path, attachmentRoot())')).toBeGreaterThan(0)
    expect(generic.indexOf('touchesAttachmentStore(path, attachmentRoot())')).toBeLessThan(generic.indexOf('shell.openPath(path)'))
  })

  it('AC-5.7 (030 verify) the open audit lines carry no file name', () => {
    const open = main.slice(at(main, "case 'attachment.open'"), at(main, 'const attachmentRoot'))
    expect(open).not.toMatch(/target:|basename|request\.path[^)]*audit/)
  })
})
