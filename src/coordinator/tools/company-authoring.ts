import * as z from 'zod/v4'
import { buildCompany, defaultCompanyVault, type NewCompanyInput, type PositionSpec } from '../../shared/company'
import { COMPANY_LIMITS, companyIssues, proposalOfCreation, vaultIssues, type CompanyIssue } from '../../shared/companyAuthoring'
import { BUILTIN_TOOLS } from '../../shared/defaults'
import { translateText, type MessageKey } from '../../shared/i18n/messages'
import type { ThreadChannel, ToolText } from '../../shared/types'
import { builtinToolsByName } from './index'
import { defineTool, ToolError, toolText, type CompanyAuthoringHost, type ToolContext, type ToolDefinition } from './types'

/**
 * Who may be offered `create_company` / `edit_company` (spec 029 BR-9, BR-24): an attended, top-level run of an agent
 * with no company seat, on the desktop, Telegram or the paired phone. An allow-list, so a future channel is not offered by accident.
 */
export function offersCompanyAuthoring(run: { depth: number; unattended?: boolean; hasSeat: boolean; channel?: ThreadChannel }): boolean {
  if (run.depth !== 0 || run.unattended || run.hasSeat) return false
  return run.channel === undefined || run.channel === 'telegram' || run.channel === 'remote'
}

type IssueKey = Exclude<CompanyIssue['code'], 'budget.range'> | 'budget.company' | 'budget.member'
/** One dictionary text per problem; typed as a whole map so a new issue code without a text does not compile. The budget has one text per scope. */
const ISSUE_KEYS: Record<IssueKey, MessageKey> = {
  'name.empty': 'tool.company.invalid.name.empty',
  'name.long': 'tool.company.invalid.name.long',
  'name.taken': 'tool.company.invalid.name.taken',
  'color.unknown': 'tool.company.invalid.color.unknown',
  'mission.long': 'tool.company.invalid.mission.long',
  'goals.long': 'tool.company.invalid.goals.long',
  'budget.company': 'tool.company.invalid.budget.company',
  'budget.member': 'tool.company.invalid.budget.member',
  'companies.full': 'tool.company.invalid.companies.full',
  'positions.none': 'tool.company.invalid.positions.none',
  'positions.many': 'tool.company.invalid.positions.many',
  'key.empty': 'tool.company.invalid.key.empty',
  'org.noHead': 'tool.company.invalid.org.noHead',
  'org.manyHeads': 'tool.company.invalid.org.manyHeads',
  'org.loop': 'tool.company.invalid.org.loop',
  'org.deep': 'tool.company.invalid.org.deep',
  'org.unknownBoss': 'tool.company.invalid.org.unknownBoss',
  'org.duplicateKey': 'tool.company.invalid.org.duplicateKey',
  'brief.long': 'tool.company.invalid.brief.long',
  'tool.unknown': 'tool.company.invalid.tool.unknown',
  'vault.outside': 'tool.company.invalid.vault.outside',
  'vault.chars': 'tool.company.invalid.vault.chars',
  'vault.notEmpty': 'tool.company.invalid.vault.notEmpty',
  'vault.reserved': 'tool.company.invalid.vault.reserved',
  'vault.dots': 'tool.company.invalid.vault.dots'
}

/** The dictionary text of one validation problem. */
export function issueText(issue: CompanyIssue): ToolText {
  if (issue.code === 'budget.range') return { key: ISSUE_KEYS[issue.scope === 'company' ? 'budget.company' : 'budget.member'], params: { max: issue.max } }
  const { code, ...params } = issue
  return { key: ISSUE_KEYS[code], params }
}

/** Every problem at once, in English for the model, so it can fix them all in one corrected call. */
function refuseIf(issues: CompanyIssue[], key: 'tool.company.invalid' | 'tool.company.invalidLate' = 'tool.company.invalid'): void {
  if (issues.length) throw new ToolError(key, { issues: issues.map((issue) => `- ${translateText('en', issueText(issue))}`).join('\n') })
}

const authoringOf = (ctx: Pick<ToolContext, 'authoring'>): CompanyAuthoringHost => {
  if (!ctx.authoring) throw new ToolError('tool.unavailable', { name: 'create_company' })
  return ctx.authoring
}

const PositionInput = z.strictObject({
  key: z.string().min(1).describe('A short local name for this position (for example "ceo"); the reportsTo of the other positions points at it.'),
  title: z.string().describe('The job title, shown in the org chart.'),
  reportsTo: z.string().nullable().describe('The key of the position this one reports to; null for the single head of the company, who reports to the board.'),
  description: z.string().describe('What the position is for.'),
  instructions: z.string().describe(`The position's standing instructions. Description plus instructions: at most ${COMPANY_LIMITS.briefMax} characters.`),
  tools: z.array(z.string()).describe('Names of the built-in tools the position may use (for example read_file, write_file, run_command).'),
  autoApproveTools: z.array(z.string()).optional().describe('Tools from the list above the position may use without asking the person. Grant sparingly: the person reads this before approving.'),
  canDelegate: z.boolean().describe('Whether the position may hand work to its team.'),
  allowMcp: z.boolean().optional().describe('Whether the position may use the connected MCP servers. Default false.'),
  budgetUsd: z.number().optional().describe(`Monthly cap for this position in USD, above 0 and at most ${COMPANY_LIMITS.budgetMaxUsd}. Omit for only the company cap.`)
})

const CreateCompanyInput = z.strictObject({
  name: z.string().describe(`The company name, at most ${COMPANY_LIMITS.nameMax} characters, not used by another company.`),
  mission: z.string().optional().describe(`What the company is for, at most ${COMPANY_LIMITS.missionMax} characters.`),
  goals: z.string().optional().describe(`What it should achieve, at most ${COMPANY_LIMITS.goalsMax} characters.`),
  color: z.string().optional().describe('One of the eight palette colours (hex). Omit to let the app pick.'),
  budgetUsd: z.number().optional().describe(`Monthly budget in USD, above 0 and at most ${COMPANY_LIMITS.budgetMaxUsd}. Omit for 20.`),
  vault: z.string().optional().describe('The company folder. Omit for the default, a new folder named after the company next to the main vault.'),
  positions: z
    .array(PositionInput)
    .describe(`Between 1 and ${COMPANY_LIMITS.maxPositions} positions: exactly one head (reportsTo null), the others report to another position, at most ${COMPANY_LIMITS.maxLevels} levels, no loops.`)
})
type CreateCompanyInput = z.infer<typeof CreateCompanyInput>

/** The creation as the shared rules and the builder take it; the card and the write both start from this, so they cannot differ (AC-6.1). */
function companyInput(input: CreateCompanyInput, host: CompanyAuthoringHost): NewCompanyInput {
  return {
    name: input.name,
    mission: input.mission ?? '',
    goals: input.goals ?? '',
    vault: input.vault ?? defaultCompanyVault(host.defaultVaultPath, input.name),
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
    positions: input.positions.map(({ autoApproveTools, ...position }) => ({ ...position, ...(autoApproveTools ? { autoApprove: autoApproveTools } : {}) }))
  }
}

/** Everything wrong with a creation against the settings of this moment (the card waits, so it is asked again after the answer). */
async function problemsOf(proposal: NewCompanyInput, ctx: ToolContext, host: CompanyAuthoringHost): Promise<CompanyIssue[]> {
  const { settings } = ctx
  const found = companyIssues(proposal, { existing: settings.companies, catalogue: BUILTIN_TOOLS })
  const rules = {
    defaultVaultPath: host.defaultVaultPath,
    // The main vault, the active one and every company's: a superset of "the main vault" (plan G-4).
    reserved: [host.defaultVaultPath, settings.activeVault, ...settings.companies.map((company) => company.vault)].filter(Boolean)
  }
  // The disk is asked only about a folder the rules already accept, so a path outside Empresas is never probed.
  let vault = vaultIssues(proposal.vault, { ...rules, hasFiles: false })
  if (!vault.length) vault = vaultIssues(proposal.vault, { ...rules, hasFiles: await host.folderHasFiles(proposal.vault) })
  return [...found, ...vault]
}

/**
 * SEAM (spec 029 G-2, task T14): the fixed header in front of every position's instructions (BR-15, AC-6.5) is not applied
 * until the human fixes its wording. Until then instructions are saved verbatim, and the card says so (`BRIEF_HEADER_APPLIED`).
 * T14 changes these two lines only.
 */
const BRIEF_HEADER_APPLIED = false
const briefed = (positions: PositionSpec[]): PositionSpec[] => positions

const createCompanyTool = defineTool({
  name: 'create_company',
  description:
    'Creates a company: a team of agents with an org chart, a folder (vault) and a monthly budget, after the person approves it on a card that shows everything. Design the positions yourself (any titles and reporting lines) and write titles, descriptions and instructions in the language of the app, stated in the reply-language rule of the system prompt. A proposal that fails validation is refused before the person sees anything, so fix the listed problems and call again in the same run; but once a proposal has reached the person on the card (approved or denied) the run is spent and only a new message from the person can start another. It cannot delete or edit companies.',
  risk: 'publish',
  standalone: true,
  previewRequired: true,
  auditAction: 'company.create',
  schema: CreateCompanyInput,
  async validate(input, ctx) {
    const host = authoringOf(ctx)
    ctx.reportAudit?.({ positions: input.positions.length })
    // A proposal that passed validation reaches the card, and that spends the run (plan G-5, amended): refused calls do not count.
    if (host.calls.create >= 1) throw new ToolError('tool.company.onlyOne')
    refuseIf(await problemsOf(companyInput(input, host), ctx, host))
    // Calls of one turn validate side by side across the await above: this increment, with no await before the return, decides which one gets the card.
    if (++host.calls.create > 1) throw new ToolError('tool.company.onlyOne')
  },
  async preview(input, ctx) {
    return { company: proposalOfCreation(companyInput(input, authoringOf(ctx)), (tool) => builtinToolsByName.get(tool)?.risk, ctx.settings.companies.length, BRIEF_HEADER_APPLIED) }
  },
  async run(input, ctx) {
    const host = authoringOf(ctx)
    const proposal = companyInput(input, host)
    // The card waited for the person: what changed meanwhile (a name, the tenth company, a filled folder) is checked again, before anything is written.
    refuseIf(await problemsOf(proposal, ctx, host), 'tool.company.invalidLate')
    const { company, agents } = buildCompany({ ...proposal, positions: briefed(proposal.positions) }, ctx.settings.companies)
    try {
      await host.initVault(company.vault)
    } catch (error) {
      throw new ToolError('tool.company.vaultFailed', { reason: (error as Error).message })
    }
    host.save((current) => ({
      companies: [...current.companies, company],
      agents: [...current.agents, ...agents],
      vaults: [...new Set([...current.vaults, company.vault])]
    }))
    ctx.reportAudit?.({ companyId: company.id })
    return toolText(ctx, 'tool.company.created', {
      name: company.name,
      id: company.id,
      vault: company.vault,
      positions: company.members.map((member) => `- ${member.title} (${member.id})`).join('\n')
    })
  }
})

/**
 * WITHHELD (spec 029 gap G-1): `edit_company` is not offered until its contract (what an edit may change, how the card shows it) is fixed.
 * Its name stays in `COMPANY_AUTHORING_TOOLS` so the approval rules (BR-23) are ready; add the real tool here when it exists.
 */
export const companyAuthoringTools: ToolDefinition[] = [createCompanyTool]
