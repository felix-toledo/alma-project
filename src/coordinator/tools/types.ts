import * as z from 'zod/v4'
import { translateText, type MessageKey, type ParamsArg } from '../../shared/i18n/messages'
import type { AgentProfile, HostRequest, Language, PendingApproval, Routine, Settings, ToolText } from '../../shared/types'
import type { AttachmentReader } from '../attachments/store'
import type { RecentMessage } from '../channels/whatsapp'
import type { CompanyEngine } from '../company/engine'
import type { Company } from '../../shared/types'
import type { KnowledgeBase } from '../knowledge/base'
import type { HomeService } from '../home'

/**
 * read: never needs approval. write/exec: go through the approval policy.
 * memory: Alma's own notes in the vault (memories, knowledge); written without asking, blocked only in read-only mode.
 * home: everyday control of the house (lights, plugs, scenes, the plan); like memory, never asks.
 * publish: acts on the outside world in the user's name, so the user approves every single call.
 */
export type ToolRisk = 'read' | 'write' | 'exec' | 'memory' | 'publish' | 'home'

/** Work only the main process can do (it owns windows and the browser session). */
export interface Host {
  request(request: HostRequest): Promise<{ ok: boolean; message: string }>
}

/** The language of the run a tool call belongs to. Contexts built by hand (tests) carry none and read as Spanish. */
export const languageOf = (ctx: Pick<ToolContext, 'language' | 'settings'>): Language => ctx.language ?? ctx.settings?.language ?? 'es'

/** Scalars only: what a tool may put in the audit line of its own (ids and counts, never what the person wrote). */
export type AuditDetail = Record<string, string | number | boolean | null>

/** What `create_company` / `edit_company` need from the shell (spec 029): injected so tests fake all of it. */
export interface CompanyAuthoringHost {
  /** The base of `<parent>\Empresas\`. */
  defaultVaultPath: string
  folderHasFiles(path: string): Promise<boolean>
  initVault(path: string): Promise<void>
  /** `update` is applied to the live settings at once (no await in between), so a save never overwrites what changed while the run waited. */
  save(update: (current: Settings) => { companies: Company[]; agents: AgentProfile[]; vaults?: string[]; routines?: Routine[] }): void
  /** Per run, created fresh with the run. */
  calls: { create: number }
}

export interface ToolContext {
  workspace: string
  signal: AbortSignal
  settings: Settings
  /** The language of the run this call belongs to, fixed when the run started. */
  language?: Language
  /** Set by the agent: gets the key of a result written through `toolText`, to store it for display. */
  reportText?(text: ToolText): void
  /** Set by the agent for a tool with an `auditAction`: adds ids and counts to that tool's audit line, whatever the outcome. */
  reportAudit?(detail: AuditDetail): void
  host: Host
  /** The active vault, if any. */
  knowledge?: KnowledgeBase | null
  threadId?: string
  /** The agent running the tool. */
  agentId?: string
  /** Persists the routine list (main owns settings). */
  saveRoutines?(routines: Routine[]): void
  /** Sends a message to the user's own Telegram chat; false if Telegram isn't connected. */
  sendTelegram?(text: string): Promise<boolean>
  /** Set when the agent works in a company: its seat in the org chart. `noAsk`: it's answering a colleague. */
  company?: { company: Company; memberId: string; engine: CompanyEngine; noAsk?: boolean }
  /** The house, when domotica is turned on. */
  home?: HomeService
  /** Where pictures the user sent are saved (look_at_image may read them). */
  inboxDir?: string
  /** Sends a picture to the user's own Telegram chat; false if Telegram isn't connected. */
  sendTelegramPhoto?(jpeg: Buffer, caption: string): Promise<boolean>
  /** The attachments store, for `read_attachment` (spec 030): ids in, files out, no listing. */
  attachments?: AttachmentReader
  /** Present only in a run that may create or edit companies (spec 029). */
  authoring?: CompanyAuthoringHost
  /** The user's linked WhatsApp, when it's turned on. */
  whatsapp?: {
    resolve(to: string): Promise<{ jid: string; label: string }>
    send(jid: string, text: string): Promise<void>
    recentMessages(from?: string, limit?: number): RecentMessage[]
  }
}

export interface ToolDefinition<I = unknown> {
  name: string
  description: string
  risk: ToolRisk
  /** True for tools that don't touch the conversation's workspace folder (vault, routines), so none is needed. */
  standalone?: boolean
  schema: z.ZodType<I>
  run(input: I, ctx: ToolContext): Promise<string>
  /** What the user sees in the approval card besides the raw input. */
  preview?(input: I, ctx: ToolContext): Promise<PendingApproval['preview']>
  /** Runs after the Zod parse and before preview and approval; a `ToolError` ends the call with no card. */
  validate?(input: I, ctx: ToolContext): Promise<void>
  /** Fail closed: with no preview (missing or failed) the call errors instead of asking. */
  previewRequired?: boolean
  /** Every outcome (including a call refused by `validate` or a missing required preview, before any card) is audited under this action, with the detail the tool reports, instead of the generic `tool.authorize` / `tool.run`. */
  auditAction?: string
  /** The run cuts a result to the middle at this many characters instead of the default; only for a tool whose own limit is higher (`read_attachment`). */
  maxResultChars?: number
}

/**
 * An error whose message goes back to the model as an `is_error` tool result. It is always built from a dictionary
 * key: it reads in English for the model and keeps the key so the card can show it in the person's language.
 */
export class ToolError extends Error {
  readonly text: ToolText
  constructor(key: MessageKey, params?: ToolText['params']) {
    const text: ToolText = { key, ...(params ? { params } : {}) }
    super(translateText('en', text))
    this.text = text
  }
}

/** An error as the person reads it: a `ToolError` in the app language, any other error as it is (the model reads `message`, English). */
export function shownError(error: Error, language: Language): string {
  return error instanceof ToolError ? translateText(language, error.text) : error.message
}

/** The same as `toolText` for a `ToolText` that was built elsewhere (the company engine returns them). */
export function sayText(ctx: Pick<ToolContext, 'reportText'>, text: ToolText): string {
  ctx.reportText?.(text)
  return translateText('en', text)
}

/** A tool result written by Alma: English for the model, and the key reported so the card shows it translated. */
export function toolText<K extends MessageKey>(ctx: Pick<ToolContext, 'reportText'>, key: K, ...params: ParamsArg<K>): string {
  const text: ToolText = { key, ...(params[0] ? { params: params[0] as ToolText['params'] } : {}) }
  ctx.reportText?.(text)
  return translateText('en', text)
}

export function defineTool<S extends z.ZodType>(tool: {
  name: string
  description: string
  risk: ToolRisk
  standalone?: boolean
  schema: S
  run(input: z.infer<S>, ctx: ToolContext): Promise<string>
  preview?(input: z.infer<S>, ctx: ToolContext): Promise<PendingApproval['preview']>
  validate?(input: z.infer<S>, ctx: ToolContext): Promise<void>
  previewRequired?: boolean
  auditAction?: string
  maxResultChars?: number
}): ToolDefinition {
  return tool as unknown as ToolDefinition
}

/** JSON Schema for a tool's input, as both providers expect it. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

const MAX_RESULT_CHARS = 24_000

/** Keeps the start and end of long outputs, which is where errors and summaries usually are. */
export function truncateMiddle(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n\n… [${text.length - max} characters omitted] …\n\n${text.slice(-half)}`
}
