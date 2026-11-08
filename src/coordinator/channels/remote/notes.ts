import { REMOTE_LIMITS, type RemoteResponse } from '../../../shared/remote/api'
import type { Settings, VaultEntry } from '../../../shared/types'
import { canonicalVaultPath, findByName, isReachable, listFolder, resolveVaultAsset } from '../../../shared/vault/paths'
import { ToolError } from '../../tools/types'
import { okResponse as ok, refusalResponse } from './transport'

/** The active vault as the phone reads it; `KnowledgeBase` already has these (confined, read-only). */
export interface RemoteVault {
  /** No active vault, or its folder is missing. */
  state(): 'none' | 'ready'
  tree(): Promise<VaultEntry[]>
  readText(path: string): Promise<{ content: string; mtime: number }>
  readBytes(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; mtime: number }>
}

export interface NotesDeps {
  /** Read at each request: the vault active now, never one remembered (BR-22). */
  vault(): RemoteVault | null
  settings(): Settings
  /** Milliseconds, injected so the tree cache expiry is testable; without it every request walks the tree. */
  now?(): number
}

/** A note with ten images asks for the tree eleven times; one walk serves them all for this long. */
export const TREE_TTL_MS = 2000

const NO_VAULT = { vault: 'none' } as const
const NOTE_EXT = /\.md$/i
const MEDIA_TYPES: Record<string, string | undefined> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif'
}

/** Over its size cap: the vault's own 5 MiB refusal and ours are the same answer. */
const isTooBig = (error: unknown): boolean => error instanceof ToolError && error.text.key === 'tool.kb.tooBig'

/**
 * What the phone reads of the active vault (spec 028). Scope and device checks already ran in the pipeline; the vault is
 * asked for at each request and the exclusion list is read from the settings at each request.
 */
export class NotesFlow {
  private cached: { vault: string; at: number; entries: VaultEntry[] } | null = null

  constructor(private readonly deps: NotesDeps) {}

  /** The vault changed (the coordinator's `vault.changed` event): the next request walks the tree again. */
  invalidate(): void {
    this.cached = null
  }

  /** The active vault and its whole tree (filtering is the pure layer's job), or null when there is none to show (none open, folder gone, unreadable). */
  private async open(): Promise<{ vault: RemoteVault; entries: VaultEntry[] } | null> {
    const vault = this.deps.vault()
    if (!vault || vault.state() !== 'ready') {
      this.cached = null
      return null
    }
    // Keyed by the vault's path, so switching vaults never serves the other one's tree.
    const key = this.deps.settings().activeVault
    const hit = this.cached
    const now = this.deps.now
    if (hit && hit.vault === key && now && now() - hit.at < TREE_TTL_MS) return { vault, entries: hit.entries }
    const at = now?.() ?? 0
    const entries = await vault.tree().catch(() => null)
    this.cached = entries && now ? { vault: key, at, entries } : null
    return entries ? { vault, entries } : null
  }

  async list(folder: string): Promise<RemoteResponse> {
    const open = await this.open()
    if (!open) return ok(NO_VAULT)
    const settings = this.deps.settings()
    return ok({ folder, entries: listFolder(open.entries, folder, settings.remote.vaultExcluded, settings.language) })
  }

  async find(query: string): Promise<RemoteResponse> {
    const open = await this.open()
    if (!open) return ok(NO_VAULT)
    return ok({ found: findByName(open.entries, query, this.deps.settings().remote.vaultExcluded) })
  }

  /**
   * A path is served only if it names a reachable file the vault's own tree lists, and what is read is the tree's spelling
   * of it: aliases the tree never shows (8.3 names, a junction out) and anything hidden or excluded get the one `unavailable`
   * answer a missing path gets, before any size or type answer could tell them apart.
   */
  private async reachableFile(open: { entries: VaultEntry[] }, path: string): Promise<VaultEntry | undefined> {
    if (!isReachable(path, this.deps.settings().remote.vaultExcluded)) return undefined
    const wanted = canonicalVaultPath(path)
    return open.entries.find((entry) => entry.kind === 'file' && canonicalVaultPath(entry.path) === wanted)
  }

  async read(path: string): Promise<RemoteResponse> {
    const open = await this.open()
    const entry = open ? await this.reachableFile(open, path) : undefined
    if (!open || !entry) return refusalResponse('unavailable')
    if (!NOTE_EXT.test(entry.path)) return refusalResponse('unsupported')
    if (entry.size > REMOTE_LIMITS.requestBytes) return refusalResponse('too-large')
    try {
      const { content, mtime } = await open.vault.readText(entry.path)
      if (Buffer.byteLength(content, 'utf8') > REMOTE_LIMITS.requestBytes) return refusalResponse('too-large')
      return ok({ path: entry.path, content, mtime })
    } catch (error) {
      return refusalResponse(isTooBig(error) ? 'too-large' : 'unavailable')
    }
  }

  /** An image a note embeds or links: `target` as written in the note at `from` ('' when opened directly), resolved over what the phone may reach only; `onResolved` hears the vault path it resolved to (for the audit entry). */
  async image(target: string, from: string, onResolved?: (path: string) => void): Promise<RemoteResponse> {
    const open = await this.open()
    const path = open ? resolveVaultAsset(target, from, open.entries, this.deps.settings().remote.vaultExcluded) : null
    const entry = path ? open?.entries.find((known) => known.path === path) : undefined
    if (!open || !entry) return refusalResponse('unavailable')
    onResolved?.(entry.path)
    const mediaType = MEDIA_TYPES[/\.([a-z0-9]+)$/i.exec(entry.path)?.[1]?.toLowerCase() ?? '']
    if (!mediaType) return refusalResponse('unsupported')
    if (entry.size > REMOTE_LIMITS.photoBytes) return refusalResponse('too-large')
    try {
      const { bytes } = await open.vault.readBytes(entry.path, REMOTE_LIMITS.photoBytes)
      return ok({ photo: Buffer.from(bytes).toString('base64'), mediaType })
    } catch (error) {
      return refusalResponse(isTooBig(error) ? 'too-large' : 'unavailable')
    }
  }
}
