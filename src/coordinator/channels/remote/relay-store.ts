// The relay credentials the PC keeps (spec 027 PD-15): its routing id and the domain its phones paired under, sealed.
// Nothing here logs and nothing in it is a secret: a damaged file is the same as no file, but it is reported (`onProblem`) so the caller can say so.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isRelayDomain, isRoutingId, newRoutingId } from '../../../shared/remote/relay-config'
import type { SealBox } from './store'

export interface RelayStoreDeps {
  /** The remote folder; the file is `relay-sealed` in it. */
  dir: string
  sealBox: SealBox
  random(length: number): Uint8Array
  /** The relay domain this build uses. */
  domain(): string
  /** Something the person would want to know: the file could not be read (a new id will be made) or a change could not be kept. */
  onProblem?(problem: 'damaged' | 'unsaved'): void
}

interface Stored {
  routingId: string
  pairedDomain: string | null
  /** Set once the domain was seen to differ from the paired one; cleared only by acting on it. */
  renamed: boolean
}

function parse(value: unknown): Stored | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.routingId !== 'string' || !isRoutingId(row.routingId)) return null
  if (row.pairedDomain !== null && (typeof row.pairedDomain !== 'string' || !isRelayDomain(row.pairedDomain))) return null
  if (row.renamed !== undefined && typeof row.renamed !== 'boolean') return null
  return { routingId: row.routingId, pairedDomain: row.pairedDomain, renamed: row.renamed === true }
}

export class RelayStore {
  private constructor(
    private readonly deps: RelayStoreDeps,
    private stored: Stored | null
  ) {}

  private get file(): string {
    return join(this.deps.dir, 'relay-sealed')
  }

  static async load(deps: RelayStoreDeps): Promise<RelayStore> {
    let stored: Stored | null = null
    let damaged = false
    try {
      stored = parse(JSON.parse(await deps.sealBox.open(readFileSync(join(deps.dir, 'relay-sealed'), 'utf8'))))
      damaged = stored === null
    } catch (error) {
      // No file is the first run; anything else in the way is damage.
      damaged = (error as NodeJS.ErrnoException).code !== 'ENOENT'
    }
    const store = new RelayStore(deps, stored)
    if (damaged) deps.onProblem?.('damaged')
    if (stored && stored.pairedDomain !== null && stored.pairedDomain !== deps.domain() && !stored.renamed) {
      stored.renamed = true
      await store.save().catch(() => deps.onProblem?.('unsaved'))
    }
    return store
  }

  routingId(): string | null {
    return this.stored?.routingId ?? null
  }

  /** Created the first time the relay is chosen and never changed after, unless the person erases. */
  async ensureRoutingId(): Promise<string> {
    if (this.stored) return this.stored.routingId
    this.stored = { routingId: newRoutingId(this.deps.random), pairedDomain: null, renamed: false }
    await this.save()
    return this.stored.routingId
  }

  pairedDomain(): string | null {
    return this.stored?.pairedDomain ?? null
  }

  /** A phone paired through the relay under this build's domain. */
  async recordPairing(): Promise<void> {
    this.stored ??= { routingId: newRoutingId(this.deps.random), pairedDomain: null, renamed: false }
    this.stored.pairedDomain = this.deps.domain()
    // The pairing itself already happened; what a failed save loses is only the note of which domain it was under.
    await this.save().catch(() => this.deps.onProblem?.('unsaved'))
  }

  renamed(): boolean {
    return this.stored?.renamed === true
  }

  /** The phones paired under the old domain were revoked: forget it, so the next pairing is the new baseline. */
  async acknowledgeRename(): Promise<void> {
    if (!this.stored) return
    this.stored.pairedDomain = null
    this.stored.renamed = false
    await this.save()
  }

  async erase(): Promise<void> {
    this.stored = null
    rmSync(this.file, { recursive: true, force: true })
  }

  private async save(): Promise<void> {
    if (!this.stored) return
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, await this.deps.sealBox.seal(JSON.stringify(this.stored)), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
