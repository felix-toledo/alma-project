// The root hash of the built phone app (spec 027 PD-13): one number for the whole shell, written next to it as
// shell-manifest.json. The PWA build runs this last; the PC announces the hash (signed) and the phone shows it.
// Usage: node scripts/shell-manifest.mts [folder]   (default out/remote)
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export const MANIFEST_FILE = 'shell-manifest.json'

export interface ShellManifest {
  version: number
  rootHash: string
  /** Every file of the shell by relative path (forward slashes), with the SHA-256 of its bytes. */
  files: Record<string, string>
}

const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')

/**
 * The hash covers each path and each file's hash, in path order, so it does not depend on the order files were read
 * in, and changes with any byte of any file, or with a file added, removed or renamed. The version rides beside it.
 */
export function computeShellManifest(contents: Record<string, Uint8Array | string>, version: number): ShellManifest {
  const files: Record<string, string> = {}
  for (const path of Object.keys(contents).sort()) files[path] = sha256(contents[path])
  const lines = Object.entries(files).map(([path, hash]) => `${path}\0${hash}\n`)
  return { version, rootHash: sha256(lines.join('')), files }
}

/** Reads every file under `dir` (but the manifest itself), and writes shell-manifest.json beside them. */
export function buildShellManifest(dir: string, version: number): ShellManifest {
  const contents: Record<string, Uint8Array> = {}
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const full = join(entry.parentPath, entry.name)
    const path = relative(dir, full).split(sep).join('/')
    if (path !== MANIFEST_FILE) contents[path] = readFileSync(full)
  }
  const manifest = computeShellManifest(contents, version)
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

if (import.meta.main) {
  // Seconds since the epoch: each build is newer than the one before, which is all the phone's downgrade check needs.
  const manifest = buildShellManifest(process.argv[2] ?? 'out/remote', Math.floor(Date.now() / 1000))
  console.log(`shell-manifest: ${Object.keys(manifest.files).length} files, version ${manifest.version}, root ${manifest.rootHash}`)
}
