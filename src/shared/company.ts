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

export function costOf(provider: ProviderId, usage: Usage): number {
  const price = PRICES[provider]
  const cached = usage.cacheReadTokens ?? 0
  return ((usage.inputTokens - cached) * price.input + cached * price.cacheRead + usage.outputTokens * price.output) / 1_000_000
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
export function memberAgent(company: Company, member: CompanyMember, template: Pick<MemberTemplate, 'description' | 'instructions' | 'tools' | 'canDelegate' | 'autoApprove'>, name: string): AgentProfile {
  return {
    id: member.id,
    name,
    description: template.description,
    systemPrompt: template.instructions,
    provider: 'meta',
    model: DEFAULT_META_MODEL,
    effort: 'medium',
    tools: template.tools,
    allowMcp: false,
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
