// Rules for companies that Alma creates or edits: ceilings, shape, names and vault folders. Pure, so the renderer and the coordinator share them.
import { canReportTo, COMPANY_COLORS, DEFAULT_COMPANY_BUDGET_USD, depth, EMPTY_EMAIL, type NewCompanyInput, type PositionSpec } from './company'
import type { Company } from './types'

export const COMPANY_LIMITS = {
  budgetMaxUsd: 100,
  maxPositions: 8,
  maxLevels: 4,
  maxCompanies: 10,
  nameMax: 60,
  missionMax: 500,
  goalsMax: 1000,
  /** Description plus instructions of one position. */
  briefMax: 2000
} as const

export type CompanyIssue =
  | { code: 'name.empty' | 'name.long' | 'name.taken' | 'color.unknown' | 'mission.long' | 'goals.long' }
  | { code: 'budget.range'; scope: 'company' | 'member'; max: number }
  | { code: 'companies.full'; max: number }
  | { code: 'positions.none' }
  | { code: 'positions.many'; max: number }
  | { code: 'key.empty' }
  | { code: 'org.noHead' | 'org.manyHeads' }
  | { code: 'brief.long'; at: string; max: number }
  | { code: 'tool.unknown'; at: string; tool: string }
  | { code: 'vault.outside' | 'vault.chars' | 'vault.notEmpty' | 'vault.reserved' | 'vault.dots' }
  | { code: 'org.loop' | 'org.deep' | 'org.unknownBoss' | 'org.duplicateKey'; at: string }

/** Alma never sets 0 (no limit) and never goes above the ceiling; an omitted budget is not checked here (the builder fills it). */
const budgetOutOfRange = (usd: number | undefined): boolean => usd !== undefined && !(usd > 0 && usd <= COMPANY_LIMITS.budgetMaxUsd)

/** The org chart of a position list, with the keys standing in for member ids, so the 007 helpers (`canReportTo`, `depth`) answer for it. */
function orgIssues(positions: PositionSpec[]): CompanyIssue[] {
  if (!positions.length) return [{ code: 'positions.none' }]
  // Before anything that grows faster than the list (the loop and depth checks are cubic), so a huge list is refused at once.
  if (positions.length > COMPANY_LIMITS.maxPositions) return [{ code: 'positions.many', max: COMPANY_LIMITS.maxPositions }]
  if (positions.some((p) => !p.key)) return [{ code: 'key.empty' }]
  const issues: CompanyIssue[] = []
  const keys = new Set<string>()
  const repeated = positions.find((p) => keys.size === keys.add(p.key).size)
  if (repeated) return [...issues, { code: 'org.duplicateKey', at: repeated.key }]
  const unknown = positions.find((p) => p.reportsTo !== null && !keys.has(p.reportsTo))
  if (unknown) issues.push({ code: 'org.unknownBoss', at: unknown.key })
  const heads = positions.filter((p) => p.reportsTo === null).length
  if (heads === 0) issues.push({ code: 'org.noHead' })
  if (heads > 1) issues.push({ code: 'org.manyHeads' })
  const chart: Company = {
    id: '', name: '', mission: '', goals: '', vault: '', color: '', budgetUsd: 0, email: EMPTY_EMAIL, whatsapp: false, createdAt: 0,
    members: positions.map((p) => ({ id: p.key, title: p.title, reportsTo: p.reportsTo, collaborates: [], budgetUsd: 0 }))
  }
  const looped = positions.find((p) => !canReportTo(chart, p.key, p.reportsTo))
  if (looped) issues.push({ code: 'org.loop', at: looped.key })
  // A level is a position in the chain, so four levels = three bosses above the lowest.
  const deep = positions.find((p) => depth(chart, p.key) >= COMPANY_LIMITS.maxLevels)
  if (deep) issues.push({ code: 'org.deep', at: deep.key })
  return issues
}

/** What the approval card shows; built here so the card holds no rule. */
export interface CompanyProposalView {
  kind: 'create' | 'edit'
  company: string
  mission: string
  goals: string
  /** What will be saved: the palette colour asked for, or the one the builder picks. */
  color: string
  vault?: string
  budgetUsd?: number
  positions: {
    title: string
    /** Monthly cap of the position in USD; 0 = only the company cap. */
    budgetUsd: number
    /** Title of the boss; null = the board. */
    boss: string | null
    description: string
    instructions: string
    tools: string[]
    autoApprove: string[]
    canDelegate: boolean
    allowMcp: boolean
    /** An auto-approved tool of risk `exec`: the position can run commands without asking. */
    runsCommandsUnasked: boolean
  }[]
  /** The fixed brief header is put in front of the instructions (BR-15). */
  briefHeaderAdded: boolean
}

export function companyIssues(input: NewCompanyInput, ctx: { existing: Company[]; catalogue: readonly string[] }): CompanyIssue[] {
  const issues: CompanyIssue[] = []
  if (ctx.existing.length >= COMPANY_LIMITS.maxCompanies) issues.push({ code: 'companies.full', max: COMPANY_LIMITS.maxCompanies })
  const name = input.name.trim()
  if (!name) issues.push({ code: 'name.empty' })
  else {
    // The raw length counts: the builder stores the name as given.
    if (input.name.length > COMPANY_LIMITS.nameMax) issues.push({ code: 'name.long' })
    if (ctx.existing.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())) issues.push({ code: 'name.taken' })
  }
  if (input.color !== undefined && !COMPANY_COLORS.includes(input.color)) issues.push({ code: 'color.unknown' })
  if (input.mission.length > COMPANY_LIMITS.missionMax) issues.push({ code: 'mission.long' })
  if (input.goals.length > COMPANY_LIMITS.goalsMax) issues.push({ code: 'goals.long' })
  if (budgetOutOfRange(input.budgetUsd)) issues.push({ code: 'budget.range', scope: 'company', max: COMPANY_LIMITS.budgetMaxUsd })
  if (input.positions.some((p) => budgetOutOfRange(p.budgetUsd))) issues.push({ code: 'budget.range', scope: 'member', max: COMPANY_LIMITS.budgetMaxUsd })
  issues.push(...orgIssues(input.positions))
  for (const p of input.positions) {
    if (p.description.length + p.instructions.length > COMPANY_LIMITS.briefMax) issues.push({ code: 'brief.long', at: p.key, max: COMPANY_LIMITS.briefMax })
    for (const tool of new Set([...p.tools, ...(p.autoApprove ?? [])])) if (!ctx.catalogue.includes(tool)) issues.push({ code: 'tool.unknown', at: p.key, tool })
  }
  return issues
}

// Windows paths as plain strings (no node:path: the renderer imports this file). Slashes either way, case ignored.
const segmentsOf = (path: string): string[] => path.replace(/\//g, '\\').split('\\').filter(Boolean)
const samePath = (a: string[], b: string[]): boolean => a.length === b.length && a.every((part, i) => part.toLowerCase() === b[i].toLowerCase())

/** A folder name Windows creates as written: no forbidden or control characters, no trailing dot or space (it would silently drop them), not a device name (with or without extension). */
const windowsFolderName = (name: string): boolean =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  !/[:*?"<>|\x00-\x1f]|[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)

/** 029 BR-14: one new folder directly under `<parent of the default vault>\Empresas\`, not holding files, not a vault already in use. `hasFiles` is measured by the caller. */
export function vaultIssues(vault: string, ctx: { defaultVaultPath: string; reserved: string[]; hasFiles: boolean }): CompanyIssue[] {
  const parts = segmentsOf(vault)
  if (parts.some((part) => part === '.' || part === '..')) return [{ code: 'vault.dots' }]
  const root = [...segmentsOf(ctx.defaultVaultPath).slice(0, -1), 'Empresas']
  const unc = /^[\\/]{2}/.test(vault)
  if (unc || parts.length <= root.length || !samePath(parts.slice(0, root.length), root)) return [{ code: 'vault.outside' }]
  const issues: CompanyIssue[] = []
  const rest = parts.slice(root.length)
  if (rest.length > 1 || !windowsFolderName(rest[0])) issues.push({ code: 'vault.chars' })
  if (ctx.hasFiles) issues.push({ code: 'vault.notEmpty' })
  if (ctx.reserved.some((path) => samePath(segmentsOf(path), parts))) issues.push({ code: 'vault.reserved' })
  return issues
}

/** `riskOf` is the coordinator's view of the tool catalogue, passed in so shared imports none of it; `existingCount` is how many companies exist, which picks the colour when none is asked for; `briefHeaderAdded` is whether the caller really puts the header in front of the instructions (BR-15). */
export function proposalOfCreation(input: NewCompanyInput, riskOf: (tool: string) => string | undefined, existingCount = 0, briefHeaderAdded = true): CompanyProposalView {
  const titleOf = new Map(input.positions.map((p) => [p.key, p.title]))
  return {
    kind: 'create',
    company: input.name,
    mission: input.mission,
    goals: input.goals,
    color: input.color ?? COMPANY_COLORS[existingCount % COMPANY_COLORS.length],
    vault: input.vault,
    budgetUsd: input.budgetUsd ?? DEFAULT_COMPANY_BUDGET_USD,
    positions: input.positions.map((p) => ({
      title: p.title,
      budgetUsd: p.budgetUsd ?? 0,
      // An unknown boss key is shown as the key, never as the board.
      boss: p.reportsTo === null ? null : (titleOf.get(p.reportsTo) ?? p.reportsTo),
      description: p.description,
      instructions: p.instructions,
      tools: [...p.tools],
      autoApprove: [...(p.autoApprove ?? [])],
      canDelegate: p.canDelegate,
      allowMcp: p.allowMcp ?? false,
      runsCommandsUnasked: (p.autoApprove ?? []).some((tool) => riskOf(tool) === 'exec')
    })),
    briefHeaderAdded
  }
}

export const COMPANY_AUTHORING_TOOLS = ['create_company', 'edit_company'] as const
/** Telegram and the phone show the input cut; WhatsApp (the user's and a company's) and voice show none of it. */
export type AnswerChannel = 'desktop' | 'telegram' | 'phone' | 'whatsapp' | 'voice'

/** How much of an approval's input Telegram and the phone show (the phone's own limit must equal it). */
export const APPROVAL_INPUT_LIMIT = 1500

/** BR-23: Telegram and the phone show the input cut at `limit`; for these tools they may not allow what they could not show whole. Deny is never gated, the caller applies this to allow only. */
export function canAnswerFrom(via: AnswerChannel, approval: { toolName: string; input: unknown }, limit: number): boolean {
  if (via === 'desktop' || !(COMPANY_AUTHORING_TOOLS as readonly string[]).includes(approval.toolName)) return true
  // Fail closed: a channel that shows nothing of the proposal cannot allow it.
  if (via === 'whatsapp' || via === 'voice') return false
  return JSON.stringify(approval.input, null, 1).length <= limit
}
