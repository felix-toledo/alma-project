// Append-only audit trail: JSON lines, one file per month and per process (`main-2026-11.jsonl`,
// `coordinator-2026-11.jsonl`). Each line carries the SHA-256 of the line before it, so an edited, removed or
// reordered entry breaks the chain and verifyAudit() says where. It never stores secrets or message content:
// callers pass identifiers and outcomes, and detail values go through redact() anyway.
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export type AuditSource = 'main' | 'coordinator'

export interface AuditEvent {
  /** Dotted verb: `tool.authorize`, `settings.update`, `secret.set`… */
  action: string
  /** Who triggered it: the person at the keyboard, an agent, a remote chat channel, or the app itself. */
  actor: 'user' | 'agent' | 'remote' | 'system'
  /** What it acted on: a tool name, a settings key, a provider id. */
  target?: string
  outcome: 'ok' | 'denied' | 'error'
  detail?: Record<string, string | number | boolean | null>
  /** Drops the event if the same action+target was already logged in the last minute (spammable inputs). */
  throttle?: boolean
}

/** Months of trail kept on disk; older files are removed at startup (the chain then starts at the oldest kept line). */
export const AUDIT_RETENTION_MONTHS = 13
const GENESIS = 'genesis'
const DETAIL_LIMIT = 300

let dir = ''
let source: AuditSource = 'main'
let last = GENESIS
const recent = new Map<string, number>()

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Masks provider keys, bearer tokens and `password=`-style pairs, and caps the length. */
export function redact(text: string): string {
  return text
    .replace(/\b(?:xai|sk|LLM)[-|][\w-]{16,}/g, '[clave]')
    .replace(/\bBearer\s+[\w.~+/=-]{8,}/gi, 'Bearer [clave]')
    .replace(/\b(pass(?:word|wd)?|token|secret|api[_-]?key)(\s*[=:]\s*)\S+/gi, '$1$2[oculto]')
    .slice(0, DETAIL_LIMIT)
}

const filesOf = (folder: string, who: AuditSource): string[] =>
  readdirSync(folder)
    .filter((name) => name.startsWith(`${who}-`) && name.endsWith('.jsonl'))
    .sort()

const monthOf = (date: Date): string => date.toISOString().slice(0, 7)

/** Opens this process's trail: continues the chain from the newest file and drops files past the retention window. */
export function initAudit(dataDir: string, who: AuditSource, now = new Date()): void {
  dir = join(dataDir, 'audit')
  source = who
  last = GENESIS
  try {
    mkdirSync(dir, { recursive: true })
    const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - AUDIT_RETENTION_MONTHS, 1))
    const files = filesOf(dir, who)
    for (const name of files.filter((n) => n.slice(who.length + 1, -6) < monthOf(cutoff))) rmSync(join(dir, name), { force: true })
    const newest = filesOf(dir, who).at(-1)
    const lines = newest ? readFileSync(join(dir, newest), 'utf8').trimEnd().split('\n') : []
    if (lines.length && lines.at(-1)) last = sha256(lines.at(-1)!)
  } catch (error) {
    console.error('[audit] could not open the log:', error)
    dir = ''
  }
}

/** Records one event. A failure to write is reported on the console and never interrupts the app. */
export function audit(event: AuditEvent, now = new Date()): void {
  if (!dir) return
  const { throttle, detail, ...rest } = event
  if (throttle) {
    const key = `${event.action}|${event.target ?? ''}`
    if (now.getTime() - (recent.get(key) ?? 0) < 60_000) return
    recent.set(key, now.getTime())
  }
  try {
    const safe = detail ? Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, typeof v === 'string' ? redact(v) : v])) : undefined
    const line = JSON.stringify({ ts: now.toISOString(), src: source, ...rest, ...(safe ? { detail: safe } : {}), prev: last })
    appendFileSync(join(dir, `${source}-${monthOf(now)}.jsonl`), line + '\n', { encoding: 'utf8', mode: 0o600 })
    last = sha256(line)
  } catch (error) {
    console.error('[audit] could not write:', error)
  }
}

export interface AuditCheck {
  ok: boolean
  entries: number
  /** First file and line (1-based) whose `prev` doesn't match the line before it. */
  brokenAt?: { file: string; line: number }
}

/** Walks every trail on disk and checks the chains. */
export function verifyAudit(dataDir: string): AuditCheck {
  const folder = join(dataDir, 'audit')
  let entries = 0
  for (const who of ['main', 'coordinator'] as const) {
    let previous: string | null = null
    for (const file of filesOf(folder, who)) {
      const lines = readFileSync(join(folder, file), 'utf8').split('\n').filter(Boolean)
      for (const [index, line] of lines.entries()) {
        let prev: unknown
        try {
          prev = (JSON.parse(line) as { prev?: unknown }).prev
        } catch {
          return { ok: false, entries, brokenAt: { file, line: index + 1 } }
        }
        // The first line kept after a purge is the anchor: nothing before it to compare.
        if (previous !== null && prev !== previous) return { ok: false, entries, brokenAt: { file, line: index + 1 } }
        previous = sha256(line)
        entries++
      }
    }
  }
  return { ok: true, entries }
}
