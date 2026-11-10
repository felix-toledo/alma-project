// Putting files into the composer (spec 030 AC-1.x, AC-2.x, AC-3.2): the renderer hands over what it has (paths from a
// drop, the picker or the clipboard, or the bytes of a pasted picture) and this decides, file by file, what becomes a
// chip and what is refused with a reason. The bridges (disk, coordinator, the warning dialog) are injected.
import type { PathInfo, PathRead } from '../desktop-api'
import type { StoreResult } from '../types'
import { classifyFile } from './classify'
import type { MessageAttachment } from './compose'
import { defaultPictureName } from './names'
import { planAdditions, planFolderDrop } from './plan'
import { maxBase64Length } from './request'
import { ATTACH_LIMITS, type ReadFailure, type RefusalReason } from './rules'
import { isSecretLikeName } from './secrets'

/** `name` is what the person sees if the source is refused before anything is known about it. */
export type IntakeSource = { name: string; path: string } | { name: string; size: number; base64(): Promise<string> }
export type IntakeReason = RefusalReason | ReadFailure
export interface IntakeRefusal {
  name: string
  reason: IntakeReason
  /** The whole dropped folder was refused, not one file. */
  folder?: true
}
export interface IntakeDeps {
  /** False in a company agent's conversation (AC-1.11). */
  canAttach: boolean
  /** The chips already in the composer: they count toward the per-message limits. */
  existing: readonly { size: number }[]
  now(): number
  inspect(path: string): Promise<PathInfo>
  read(path: string): Promise<PathRead>
  store(file: { name: string; size: number; base64: string }): Promise<StoreResult>
  /** The secret-name warning: true = "attach anyway". */
  confirmSecret(name: string): Promise<boolean>
}
export interface IntakeResult {
  added: MessageAttachment[]
  refused: IntakeRefusal[]
  skippedFolders: { folder: string; count: number }[]
}

type Loaded = { ok: true; name: string; size: number; base64: string } | { ok: false; reason: IntakeReason }

// enough base64 for the sniffed bytes, cut on a 4-character boundary so it decodes on its own
const HEAD_CHARS = maxBase64Length(ATTACH_LIMITS.sniffBytes)

function headOf(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64.slice(0, HEAD_CHARS)), (c) => c.charCodeAt(0))
}

export async function intakeFiles(sources: readonly IntakeSource[], deps: IntakeDeps): Promise<IntakeResult> {
  const result: IntakeResult = { added: [], refused: [], skippedFolders: [] }
  const refuse = (name: string, reason: IntakeReason) => void result.refused.push({ name, reason })
  const current = () => [...deps.existing, ...result.added]

  const take = async (name: string, path: string | undefined, load: () => Promise<Loaded>): Promise<void> => {
    let loaded: Loaded
    try {
      loaded = await load()
    } catch {
      return refuse(name, 'unreadable')
    }
    if (!loaded.ok) return refuse(name, loaded.reason)
    const shown = defaultPictureName(loaded.name, deps.now())
    let verdict: ReturnType<typeof classifyFile>
    try {
      verdict = classifyFile(shown, headOf(loaded.base64), loaded.size)
    } catch {
      return refuse(shown, 'unreadable')
    }
    if (!verdict.ok) return refuse(shown, verdict.reason)
    const { refused } = planAdditions(current(), [{ name: shown, size: loaded.size, kind: verdict.kind }])
    if (refused.length) return refuse(shown, refused[0].reason)
    // a warning, never a refusal: cancelling leaves no chip and stores nothing
    if (isSecretLikeName(shown, path) && !(await deps.confirmSecret(shown))) return
    try {
      const stored = await deps.store({ name: shown, size: loaded.size, base64: loaded.base64 })
      if (stored.ok) result.added.push(stored.attachment)
      else refuse(shown, stored.reason)
    } catch {
      refuse(shown, 'storage')
    }
  }

  for (const source of sources) {
    if (!deps.canAttach) {
      refuse(source.name, 'company')
      continue
    }
    if (!('path' in source)) {
      await take(source.name, undefined, async () => ({ ok: true, name: source.name, size: source.size, base64: await source.base64() }))
      continue
    }
    let info: PathInfo
    try {
      info = await deps.inspect(source.path)
    } catch {
      refuse(source.name, 'unreadable')
      continue
    }
    if (info.kind === 'failed') refuse(source.name, info.reason)
    else if (info.kind === 'file') await take(info.name, source.path, () => deps.read(source.path))
    else {
      if (info.skipped > 0) result.skippedFolders.push({ folder: info.name, count: info.skipped })
      const plan = planFolderDrop(info.files, info.skipped, current())
      if (plan.refuseAll) result.refused.push({ name: info.name, reason: plan.reason, folder: true })
      else if (!plan.files.length) result.refused.push({ name: info.name, reason: 'empty', folder: true })
      else for (const file of plan.files) await take(file.name, file.path, () => deps.read(file.path))
    }
  }
  return result
}
