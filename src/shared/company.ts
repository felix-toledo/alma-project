// Companies: pure helpers shared by the coordinator (who may talk to whom, spend) and the window (org chart, templates).
import { DEFAULT_META_MODEL } from './defaults'
import { AGENT_NAMES } from './agentNames'
import { defaultTexts } from './i18n/defaultTexts'
import type { Language } from './i18n/language'
import type { AgentProfile, Company, CompanyMember, ProviderId, Usage } from './types'

export const BOARD = 'user'

/** The member's chain of command, nearest boss first (stops at the board). */
export function chainOfCommand(company: Company, memberId: string): CompanyMember[] {
  const byId = new Map(company.members.map((m) => [m.id, m]))
  const chain: CompanyMember[] = []
  const seen = new Set<string>([memberId])
  for (let boss = byId.get(memberId)?.reportsTo; boss && !seen.has(boss); boss = byId.get(boss)?.reportsTo) {
    seen.add(boss)
    const member = byId.get(boss)
    if (!member) break
    chain.push(member)
  }
  return chain
}

/** Everyone below the member, at any depth. */
export function subordinates(company: Company, memberId: string): CompanyMember[] {
  const out: CompanyMember[] = []
  const queue = [memberId]
  const seen = new Set(queue)
  while (queue.length) {
    const boss = queue.shift()!
    for (const member of company.members) {
      if (member.reportsTo === boss && !seen.has(member.id)) {
        seen.add(member.id)
        out.push(member)
        queue.push(member.id)
      }
    }
  }
  return out
}

export const directReports = (company: Company, memberId: string): CompanyMember[] => company.members.filter((m) => m.reportsTo === memberId)

/** Who the member can ask something (and get an answer right away): boss, reports and dotted lines, both ways. */
export function colleagues(company: Company, memberId: string): CompanyMember[] {
  const me = company.members.find((m) => m.id === memberId)
  if (!me) return []
  const ids = new Set<string>([...(me.reportsTo ? [me.reportsTo] : []), ...directReports(company, memberId).map((m) => m.id), ...me.collaborates])
  for (const other of company.members) if (other.collaborates.includes(memberId)) ids.add(other.id)
  ids.delete(memberId)
  return company.members.filter((m) => ids.has(m.id))
}

/** Making `memberId` report to `boss` must not create a loop (a boss can't report to someone below them). */
export function canReportTo(company: Company, memberId: string, boss: string | null): boolean {
  if (boss === null) return true
  if (boss === memberId) return false
  return !subordinates(company, memberId).some((m) => m.id === boss)
}

/** The top of the org chart (reports to the board): answers the company's WhatsApp and chairs by default. */
export function head(company: Company): CompanyMember | undefined {
  return company.members.find((m) => m.reportsTo === null) ?? company.members[0]
}

export function depth(company: Company, memberId: string): number {
  return chainOfCommand(company, memberId).length
}

// ---------------------------------------------------------------------------
// Spend (estimated): list prices in USD per million tokens. They change; the board sees "estimado".
// ponytail: one price per provider; per-model prices if budgets need to be exact.
export const PRICES: Record<ProviderId, { input: number; output: number; cacheRead: number }> = {
  anthropic: { input: 5, output: 25, cacheRead: 0.5 },
  xai: { input: 3, output: 15, cacheRead: 0.75 },
  deepseek: { input: 0.3, output: 1.2, cacheRead: 0.03 },
  // The gateway bills each model at its own price; this is a Sonnet-class guess.
  vercel: { input: 3, output: 15, cacheRead: 0.3 },
  // Muse Spark 1.3 (standard); Wonder costs more.
  meta: { input: 1.25, output: 4.25, cacheRead: 0.15 }
}

/** USD for a usage at a price per million tokens; the dream prices its economy models with it too (spec 033). */
export function costAt(price: { input: number; output: number; cacheRead: number }, usage: Usage): number {
  const cached = usage.cacheReadTokens ?? 0
  return ((usage.inputTokens - cached) * price.input + cached * price.cacheRead + usage.outputTokens * price.output) / 1_000_000
}

export function costOf(provider: ProviderId, usage: Usage): number {
  return costAt(PRICES[provider], usage)
}

export const monthKey = (at = new Date()): string => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`

// ---------------------------------------------------------------------------
// Templates

export interface MemberTemplate {
  key: string
  title: string
  /** Template key of the boss; null = reports to the board. */
  reportsTo: string | null
  description: string
  instructions: string
  tools: string[]
  canDelegate: boolean
  autoApprove?: string[]
}

export interface CompanyTemplate {
  id: string
  name: string
  mission: string
  goals: string
  color: string
  members: MemberTemplate[]
}

const OFFICE = ['office_read', 'office_create', 'office_edit']
const FILES = ['read_file', 'list_dir', 'search_files', 'write_file', 'edit_file']

/** The shape of a template: who reports to whom and what each position can do. The words come from the language's texts. */
type MemberStructure = Omit<MemberTemplate, 'title' | 'description' | 'instructions'>
const member = (key: string, reportsTo: string | null, tools: string[], canDelegate: boolean, autoApprove?: string[]): MemberStructure => ({
  key,
  reportsTo,
  tools,
  canDelegate,
  ...(autoApprove ? { autoApprove } : {})
})
const STAFF = [...FILES, ...OFFICE]
const CEO_SEAT = (): MemberStructure => member('ceo', null, STAFF, true)

const TEMPLATE_STRUCTURE: { id: string; color: string; members: MemberStructure[] }[] = [
  {
    id: 'marketing',
    color: '#8b5cf6',
    members: [
      CEO_SEAT(),
      member('estratega', 'ceo', STAFF, true),
      member('community', 'estratega', [...FILES, 'generate_image', 'compose_image', 'instagram_publish'], false, ['generate_image', 'compose_image', 'write_file', 'edit_file']),
      member('redactor', 'estratega', STAFF, false),
      member('metricas', 'ceo', STAFF, false)
    ]
  },
  {
    id: 'ecommerce',
    color: '#10b981',
    members: [
      CEO_SEAT(),
      member('catalogo', 'ceo', STAFF, false),
      member('marketing', 'ceo', [...FILES, 'generate_image', 'compose_image', 'instagram_publish'], false, ['generate_image', 'compose_image']),
      member('atencion', 'ceo', STAFF, false),
      member('logistica', 'ceo', STAFF, false),
      member('finanzas', 'ceo', STAFF, false)
    ]
  },
  {
    id: 'administracion',
    color: '#0ea5e9',
    members: [CEO_SEAT(), member('contable', 'ceo', STAFF, false), member('administrativo', 'ceo', STAFF, false), member('agenda', 'ceo', [...FILES], false)]
  }
]

/** The company templates, written in the language in effect when they are offered (BR-16). */
export function companyTemplates(language: Language = 'es'): CompanyTemplate[] {
  const texts = defaultTexts(language).templates
  return TEMPLATE_STRUCTURE.map(({ id, color, members }) => ({
    id,
    name: texts[id].name,
    mission: texts[id].mission,
    goals: texts[id].goals,
    color,
    members: members.map((structure) => {
      const words = texts[id].members[structure.key]
      return {
        key: structure.key,
        title: words.title,
        reportsTo: structure.reportsTo,
        description: words.description,
        instructions: words.instructions,
        tools: [...structure.tools],
        canDelegate: structure.canDelegate,
        ...(structure.autoApprove ? { autoApprove: [...structure.autoApprove] } : {})
      }
    })
  }))
}

export const COMPANY_TEMPLATES: CompanyTemplate[] = companyTemplates('es')

/** Agent profile for a position: the template's instructions on top of the company's model choice. */
export function memberAgent(company: Company, member: CompanyMember, template: Pick<MemberTemplate, 'description' | 'instructions' | 'tools' | 'canDelegate' | 'autoApprove'> & { allowMcp?: boolean }, name: string): AgentProfile {
  return {
    id: member.id,
    name,
    description: template.description,
    systemPrompt: template.instructions,
    provider: 'meta',
    model: DEFAULT_META_MODEL,
    effort: 'medium',
    tools: template.tools,
    allowMcp: template.allowMcp ?? false,
    canDelegate: template.canDelegate,
    autoApproveTools: template.autoApprove,
    companyId: company.id
  }
}

/** First names for new agents, so the org chart reads like a team ("Sofía · Community manager"). */

export function pickName(taken: string[], offset = 0): string {
  const free = AGENT_NAMES.filter((n) => !taken.includes(n))
  return (free.length ? free : AGENT_NAMES)[offset % (free.length || AGENT_NAMES.length)]
}

export const newId = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 9)}`

// ---------------------------------------------------------------------------
// Building a company (the Equipos form and, later, the tools)

export const COMPANY_COLORS = ['#8b5cf6', '#10b981', '#0ea5e9', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#6366f1']
export const EMPTY_EMAIL: Company['email'] = { address: '', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 }
export const DEFAULT_COMPANY_BUDGET_USD = 20

/** One position to create; `key` only names it so `reportsTo` can point at another one before ids exist. */
export interface PositionSpec extends MemberTemplate {
  /** Equipos leaves it off; the tools may turn it on. */
  allowMcp?: boolean
  /** Monthly cap for the member; 0 or absent = only the company cap. */
  budgetUsd?: number
}

export interface NewCompanyInput {
  name: string
  mission: string
  goals: string
  vault: string
  color?: string
  budgetUsd?: number
  positions: PositionSpec[]
}

/** 007 AC-1.2: `<parent of the default vault>\Empresas\<name>`, forbidden characters of the name replaced by `-`. Reading the base folder is the caller's job. */
export function defaultCompanyVault(defaultVaultPath: string, name: string): string {
  const root = defaultVaultPath.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '')
  // Control characters are forbidden in a folder name like the rest. Windows drops a trailing dot or space, so the folder would not be the one that was checked.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters is the point
  return `${root}\\Empresas\\${name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').trim().replace(/[. ]+$/, '') || 'Empresa'}`
}

/** The company and one agent per position, not yet saved or on disk (the caller's shell does `vault.init` and persists). */
export function buildCompany(input: NewCompanyInput, existing: Company[]): { company: Company; agents: AgentProfile[] } {
  const company: Company = {
    id: newId('empresa'),
    name: input.name,
    mission: input.mission,
    goals: input.goals,
    vault: input.vault,
    color: input.color ?? COMPANY_COLORS[existing.length % COMPANY_COLORS.length],
    budgetUsd: input.budgetUsd ?? DEFAULT_COMPANY_BUDGET_USD,
    members: [],
    email: { ...EMPTY_EMAIL },
    whatsapp: false,
    createdAt: Date.now()
  }
  const ids = new Map<string, string>()
  const agents: AgentProfile[] = []
  const start = existing.length * 5
  for (const position of input.positions) {
    const id = newId('puesto')
    ids.set(position.key, id)
    const seat: CompanyMember = { id, title: position.title, reportsTo: null, collaborates: [], budgetUsd: position.budgetUsd ?? 0 }
    company.members.push(seat)
    agents.push(memberAgent(company, seat, position, pickName(agents.map((a) => a.name), start)))
  }
  // Bosses are known once every position has an id.
  for (const [i, position] of input.positions.entries()) {
    // Only a missing boss means the board: an unknown key is a caller bug, never a second head.
    const boss = position.reportsTo == null ? null : ids.get(position.reportsTo)
    if (boss === undefined) throw new Error(`Unknown boss key: ${position.reportsTo}`)
    company.members[i].reportsTo = boss
  }
  return { company, agents }
}
