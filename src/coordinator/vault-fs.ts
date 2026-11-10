// The two disk operations behind vault folders (a new vault, a company's folder). No electron, so tests can run them.
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Language } from '../shared/i18n/language'
import { translate } from '../shared/i18n/messages'
import { welcomeNoteFile } from '../shared/i18n/names'

/** Creates the folder of a vault and, when it holds nothing visible, a welcome note. A failure (no permission, a file in the way) is the caller's to report. */
export async function initVault(path: string, language: Language): Promise<void> {
  await mkdir(path, { recursive: true })
  const visible = (await readdir(path)).filter((name) => !name.startsWith('.'))
  if (visible.length === 0) await writeFile(join(path, welcomeNoteFile(language)), translate(language, 'vault.welcomeNote'), 'utf8')
}

/** Only a folder that does not exist counts as empty: one that cannot be read is treated as occupied. */
export async function folderHasFiles(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}
