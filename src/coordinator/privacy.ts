// Rights over the personal data Alma keeps on this computer: take a copy of it, and erase it.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** What goes into an export: what the person said and what Alma remembers of them. Never keys or sessions. */
const EXPORTED = ['threads', 'companies', 'audit', 'routines-state.json', 'voice-profile.json']

/** Copies the personal data under `dataDir` into a new folder inside `targetDir` and returns its path. */
export function exportPersonalData(dataDir: string, targetDir: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const out = join(targetDir, `alma-export-${stamp}`)
  mkdirSync(out, { recursive: true })
  for (const name of EXPORTED) if (existsSync(join(dataDir, name))) cpSync(join(dataDir, name), join(out, name), { recursive: true })
  return out
}

/** Removes the files people send Alma (photos, audio) that haven't been filed anywhere else. */
export function erasePersonalFiles(inboxDir: string): void {
  rmSync(inboxDir, { recursive: true, force: true })
  mkdirSync(inboxDir, { recursive: true })
}
