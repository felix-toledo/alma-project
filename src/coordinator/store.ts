import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Language } from '../shared/i18n/language'
import { translate } from '../shared/i18n/messages'
import type { Thread, ThreadSummary } from '../shared/types'
import { ToolError } from './tools/types'

/** The title a conversation has until its first message names it: the language in effect when it is created. */
export const untitledTitle = (language: Language): string => translate(language, 'thread.untitled')

/** Either language's untitled title counts, so a conversation made before a language change still gets named. */
export const isUntitled = (title: string): boolean => title === untitledTitle('es') || title === untitledTitle('en')

/** One JSON file per thread under <userData>/threads. */
export class ThreadStore {
  private dir: string
  private threads = new Map<string, Thread>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(
    dataDir: string,
    private language: () => Language = () => 'es',
    /** Runs before a conversation goes: its attachment files are deleted with it (spec 030 AC-5.4). */
    private onDelete?: (id: string) => void
  ) {
    this.dir = join(dataDir, 'threads')
    mkdirSync(this.dir, { recursive: true })
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const thread = JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as Thread
        thread.subagents ??= {}
        thread.toolStates ??= {}
        this.threads.set(thread.id, thread)
      } catch (error) {
        console.error(`[store] skipping unreadable thread ${file}:`, error)
      }
    }
  }

  list(): ThreadSummary[] {
    return [...this.threads.values()].map(summarize).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): Thread {
    const thread = this.threads.get(id)
    if (!thread) throw new ToolError('error.noThread')
    return thread
  }

  create(agentId: string, workspace: string, channel?: Thread['channel']): Thread {
    const now = Date.now()
    const thread: Thread = {
      id: crypto.randomUUID(),
      title: untitledTitle(this.language()),
      agentId,
      workspace,
      ...(channel ? { channel } : {}),
      createdAt: now,
      updatedAt: now,
      messages: [],
      subagents: {},
      toolStates: {}
    }
    this.threads.set(thread.id, thread)
    this.flush(thread.id)
    return thread
  }

  delete(id: string): void {
    // files first: a crash in between leaves a conversation whose chips say "removed", never files nobody can delete
    try {
      this.onDelete?.(id)
    } catch (error) {
      console.error('[store] could not delete the attachments of a conversation:', error instanceof Error ? error.name : 'error')
    }
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    this.threads.delete(id)
    rmSync(this.file(id), { force: true })
  }

  /**
   * The conversation was opened (spec 030 BR-16). Unlike `save` it leaves `updatedAt` alone: retention and the sidebar
   * order key on it, and opening a conversation must neither extend one nor reorder the other.
   */
  markOpened(id: string, at: number): void {
    const thread = this.threads.get(id)
    if (!thread) return
    thread.lastOpenedAt = at
    this.schedule(id)
  }

  /** Debounced write; agent runs call this after every message. */
  save(id: string): void {
    const thread = this.threads.get(id)
    if (!thread) return
    thread.updatedAt = Date.now()
    this.schedule(id)
  }

  private schedule(id: string): void {
    clearTimeout(this.timers.get(id))
    this.timers.set(id, setTimeout(() => this.flush(id), 300))
  }

  flush(id: string): void {
    this.timers.delete(id)
    const thread = this.threads.get(id)
    if (!thread) return
    const tmp = this.file(id) + '.tmp'
    writeFileSync(tmp, JSON.stringify(thread), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.file(id))
  }

  flushAll(): void {
    for (const id of [...this.timers.keys()]) {
      clearTimeout(this.timers.get(id))
      this.flush(id)
    }
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`)
  }
}

export function summarize(thread: Thread): ThreadSummary {
  return {
    id: thread.id,
    title: thread.title,
    agentId: thread.agentId,
    ...(thread.model ? { model: thread.model } : {}),
    workspace: thread.workspace,
    updatedAt: thread.updatedAt,
    ...(thread.channel ? { channel: thread.channel } : {})
  }
}
