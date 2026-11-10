import { ATTACH_LIMITS, type AttachmentKind } from './rules'

export interface Candidate {
  name: string
  size: number
  kind: AttachmentKind
}

/** Per-message budget (BR-14): chips already present count; files are taken in order and a refused one uses no budget (G5). */
export function planAdditions(
  existing: readonly { size: number }[],
  candidates: readonly Candidate[],
): { accepted: Candidate[]; refused: { name: string; reason: 'too-many' | 'total' }[] } {
  let count = existing.length
  let total = existing.reduce((sum, e) => sum + e.size, 0)
  const accepted: Candidate[] = []
  const refused: { name: string; reason: 'too-many' | 'total' }[] = []
  for (const c of candidates) {
    if (count + 1 > ATTACH_LIMITS.maxFiles) refused.push({ name: c.name, reason: 'too-many' })
    else if (total + c.size > ATTACH_LIMITS.maxTotalBytes) refused.push({ name: c.name, reason: 'total' })
    else {
      accepted.push(c)
      count += 1
      total += c.size
    }
  }
  return { accepted, refused }
}

/** A dropped folder (BR-15): its direct files, all or nothing against the per-message budget (G5, G12). */
export function planFolderDrop<F extends { name: string; size: number }>(
  direct: readonly F[],
  skippedFolders: number,
  existing: readonly { size: number }[],
): { refuseAll: false; files: F[]; skippedFolders: number } | { refuseAll: true; reason: 'too-many' | 'total'; skippedFolders: number } {
  if (existing.length + direct.length > ATTACH_LIMITS.maxFiles) return { refuseAll: true, reason: 'too-many', skippedFolders }
  const total = [...existing, ...direct].reduce((sum, f) => sum + f.size, 0)
  if (total > ATTACH_LIMITS.maxTotalBytes) return { refuseAll: true, reason: 'total', skippedFolders }
  return { refuseAll: false, files: [...direct], skippedFolders }
}
