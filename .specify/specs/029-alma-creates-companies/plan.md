# 029 — Plan

<!-- Written once spec.md is `ready` (it is, 2026-11-08). Contracts and signatures, never logic. Spec §1-§8 is not edited here. -->

Test titles carry `AC-x.y (029)` because AC ids repeat across specs (same convention as 028).
`G-n` marks a gap or contradiction found while planning; none is decided here. They are listed in §9 and the tasks they block say so.

## 1. Approach
Move the pure part of `NewCompany.create()` (`TeamsSettings.tsx` lines 91-122) into `src/shared/company.ts` as `buildCompany`, extended to take an explicit position list. Put every ceiling, shape, name, vault-path and patch rule in a second pure shared module, `src/shared/companyAuthoring.ts`. Add two `publish` tools in `src/coordinator/tools/company-authoring.ts` that validate (Zod shape, then the shared rules, with live settings) before the card, show a structured proposal on the existing approval card, and only after "allow" call `initVault`, then persist `{ companies, agents, vaults }` through `patchSettings`. The tools are offered by an inverse of the company gate in `appTools`. Channels get one pure predicate (`canAnswerFrom`) that both hides Permitir and makes the broker refuse an `allow` the channel could not have shown whole.

Alternatives rejected:
- Validation inside `preview`: its errors are swallowed (`.catch(() => undefined)` in `executeTool`), so a bad proposal would still reach a card. A `validate` hook that runs before `authorize` and a `previewRequired` flag (fail closed) replace it.
- A new IPC from the renderer for creation: the tools run in the coordinator, which already owns the `settings.patch` path to main (`saveRoutines` precedent); no new IPC.
- Header added inside `buildCompany`: it would change what the Equipos form saves and break AC-3.3 and 007 AC-1.1/1.3 ("behavior unchanged"). The header is applied by the tool layer (see G-2).

No ADR: no new dependency, no storage format change (settings keep the same `companies`, `agents`, `vaults`), and the one hard-to-reverse choice (`publish` stretched to "a model creating autonomous agents") is already recorded in `docs/context.md` (Tool risk) and BR-3.

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | `src/shared/company.ts` (changed: `buildCompany`, `templatePositions`, `defaultCompanyVault`, `COMPANY_COLORS`, `EMPTY_EMAIL`, `memberAgent` gains `allowMcp`); `src/shared/companyAuthoring.ts` (new: limits, issue codes, validators, `applyCompanyPatch`, `proposalOfCreation`, `proposalOfEdit`, `canAnswerFrom`, `COMPANY_AUTHORING_TOOLS`); `src/shared/types.ts` (changed: `PendingApproval['preview'].company`, `CompanyProposalView`, `HostRequest` action `vault.defaultPath`); `src/shared/remote/api.ts` (changed: `ApprovalView.whole`); `src/shared/i18n/{es,en}/{companies,tools,channels}.ts` (changed) | Both `coordinator` (tools) and `renderer` (Equipos form, card) need the same rules and `coordinator` cannot import `renderer` (Constitution IV). Pure, no `node:*`, so the renderer may import it. |
| coordinator | `src/coordinator/tools/company-authoring.ts` (new: both tools, `offersCompanyAuthoring`, input schemas); `src/coordinator/tools/types.ts` (changed: `ToolDefinition.validate`, `previewRequired`, `ToolContext.authoring`, `reportAudit`); `src/coordinator/agent.ts` (changed: `appTools` gate, `RunContext.authoring`, validate/preview-required step, audit override); `src/coordinator/tool-trail.ts` (changed: dedicated action + detail); `src/coordinator/approval.ts` (changed: broker records the answering channel, refuses an unanswerable `allow`; `Authorization.via`); `src/coordinator/channels/texts.ts` and `src/coordinator/channels/telegram.ts` (changed: whole-input rule); `src/coordinator/channels/remote/approvals.ts` (changed: `whole`, refusal); `src/coordinator/index.ts` (changed: builds the authoring host per run, extracts `initVault`, `saveCompanyChange` over `patchSettings`) | Anything that thinks or does I/O for an agent. `electron` is not touched here. |
| main | `src/main/index.ts` (changed: host action `vault.defaultPath` returning the string `vault:defaultPath` already serves) | Only `main` can call `app.getPath('documents')`. Plan confirmation: `settings.patch` already applies `companies`, `agents`, `routines` and `vaults` through `settings.update(stripRemotePatch(...))` with no `guard.ts` gate on them (the gate is on the IPC `settings:update` path, for MCP commands and `always-allow`); `stripRemotePatch` touches only the `remote` key. No other `main` change. |
| renderer | `src/renderer/src/companies/TeamsSettings.tsx` (changed: calls `buildCompany`, `defaultCompanyVault`, `COMPANY_COLORS`); `src/renderer/src/components/ToolCard.tsx` (changed) plus a new `src/renderer/src/components/CompanyProposalCard.tsx`; `src/renderer/src/lib/format.ts` (changed: tool labels and one-line summaries) | Presentation only. The flag and the before/after rows come ready-made from `proposalOf*` (no rule in JSX). |
| remote-client | `src/remote-client/screens/Approvals.tsx`, `src/remote-client/i18n/{es,en}.ts` (changed) | The phone hides Permitir when `ApprovalView.whole` is false and says to see it on the PC. Own dictionaries, per `docs/architecture.md`. |

No new arrow breaks the layer rules: `shared` imports nothing; the coordinator reads `shared`; the renderer reads `shared`; `remote-client` reads only `shared/remote/*` and its own files. `tests/architecture.test.ts` needs no new rule.

## 3. Contracts
Signatures only.

### 3.1 Shared (`src/shared/company.ts`)
```ts
export const COMPANY_COLORS: readonly string[]          // the 8 swatches, moved from TeamsSettings.tsx
export const EMPTY_EMAIL: Company['email']              // moved
export const DEFAULT_COMPANY_BUDGET_USD = 20            // 007 BR-16, now owned here

export interface PositionSpec {                         // one position, free-form or from a template
  key: string                                           // local name used for reportsTo wiring only
  title: string
  reportsTo: string | null                              // another PositionSpec.key; null = the board
  description: string
  instructions: string                                  // stored verbatim by the builder
  tools: string[]
  autoApprove?: string[]
  canDelegate: boolean
  allowMcp?: boolean                                    // default false (Equipos); Alma may pass true
  budgetUsd?: number                                    // default 0
}

export interface NewCompanyInput {
  name: string; mission: string; goals: string
  vault: string
  color?: string                                        // default: COMPANY_COLORS[existing.length % 8]
  budgetUsd?: number                                    // default DEFAULT_COMPANY_BUDGET_USD
  positions: PositionSpec[]
}

export function templatePositions(template: CompanyTemplate): PositionSpec[]
export function buildCompany(input: NewCompanyInput, existing: Company[]): { company: Company; agents: AgentProfile[] }
export function defaultCompanyVault(defaultVaultPath: string, name: string): string   // 007 AC-1.2 string rule only
// memberAgent: its template Pick gains `allowMcp?: boolean` (default false). Provider/model/effort stay meta/DEFAULT_META_MODEL/medium.
```
`buildCompany` stays pure: ids from `newId` (the only impurity, as today), name offset `existing.length * 5`, `createdAt` from `Date.now()`. No disk, no settings.

### 3.2 Shared (`src/shared/companyAuthoring.ts`)
```ts
export const COMPANY_LIMITS: Readonly<{
  budgetMaxUsd: 100; maxPositions: 8; maxLevels: 4; maxCompanies: 10
  nameMax: 60; missionMax: 500; goalsMax: 1000; briefMax: 2000        // briefMax = description + instructions
}>
export const COMPANY_AUTHORING_TOOLS: readonly ['create_company', 'edit_company']

export type CompanyIssue =                                // codes, never prose; each maps to a ToolError key (§3.6)
  | { code: 'name.empty' | 'name.long' | 'name.taken' | 'color.unknown' | 'mission.long' | 'goals.long' }
  | { code: 'budget.range'; scope: 'company' | 'member'; max: number }
  | { code: 'positions.none' | 'positions.many'; max?: number }
  | { code: 'org.noHead' | 'org.manyHeads' | 'org.loop' | 'org.deep' | 'org.unknownBoss' | 'org.duplicateKey'; at?: string }
  | { code: 'brief.long'; at: string; max: number }
  | { code: 'tool.unknown'; at: string; tool: string }
  | { code: 'vault.outside' | 'vault.chars' | 'vault.notEmpty' | 'vault.reserved' | 'vault.dots' }
  | { code: 'companies.full'; max: number }

export function companyIssues(input: NewCompanyInput, ctx: { existing: Company[]; catalogue: readonly string[] }): CompanyIssue[]
export function vaultIssues(vault: string, ctx: { defaultVaultPath: string; companyName: string; reserved: string[]; hasFiles: boolean }): CompanyIssue[]
// vaultIssues is string-only (no node:path; the renderer imports shared). "hasFiles" is measured by the shell and passed in.

export function canAnswerFrom(via: AnswerChannel, approval: Pick<PendingApproval, 'toolName' | 'input'>, limit: number): boolean
export type AnswerChannel = 'desktop' | 'telegram' | 'phone'
// false only when via is telegram|phone, the tool is in COMPANY_AUTHORING_TOOLS and JSON.stringify(input, null, 1) is longer than `limit` (BR-23).

export interface CompanyProposalView {                    // what the card shows; built here, rendered in the renderer, no rule in JSX
  kind: 'create' | 'edit'
  company: string; vault?: string; budgetUsd?: number
  positions: { title: string; boss: string | null; description: string; instructions: string; tools: string[]; autoApprove: string[]; canDelegate: boolean; allowMcp: boolean; runsCommandsUnasked: boolean; change?: 'added' | 'removed' | 'changed' }[]
  changes?: { field: string; before: string; after: string }[]   // edit only
  briefHeaderAdded: boolean
}
export function proposalOfCreation(input: NewCompanyInput, riskOf: (tool: string) => string | undefined): CompanyProposalView
export function proposalOfEdit(...): CompanyProposalView                    // blocked G-1
export function applyCompanyPatch(...): { company: Company; agents: AgentProfile[]; routines: Routine[] } | { issues: CompanyIssue[] }   // blocked G-1
```
`runsCommandsUnasked` is true when a position's `autoApprove` contains a tool whose risk is `exec` (BR-22); `riskOf` is injected by the coordinator from `builtinToolsByName`, so `shared` imports no coordinator code.

### 3.3 Tool definitions (`src/coordinator/tools/company-authoring.ts`)
| Tool | `ToolRisk` | Input (Zod `z.strictObject`, so any `delete*` or unknown key fails validation, AC-4.1) |
|---|---|---|
| `create_company` | `publish` | `{ name, mission?, goals?, color?, budgetUsd?, vault?, positions: PositionInput[] }` where `PositionInput = { key, title, reportsTo: string \| null, description, instructions, tools: string[], autoApproveTools?: string[], canDelegate: boolean, allowMcp?: boolean, budgetUsd? }`. Max lengths/array sizes come from `COMPANY_LIMITS`. |
| `edit_company` | `publish` | `{ company, changes: [...] }` — **blocked G-1** (field list, how Alma names an existing company/position, and how she learns their ids are not in the spec). The schema has no field for vault folder, mailbox, WhatsApp or secrets (AC-3.14). |

Both set `standalone: true` (they touch no workspace folder), `previewRequired: true`, and descriptions in English that never change with `language` (BR-11). The description tells the model to write titles, descriptions and instructions "in the language of the app, stated in the reply-language rule of the system prompt" so the text stays static (AC-6.7, see G-9).

Results the model reads (English, via `toolText`): creation returns the company name and id, each position with its member id, and the vault path, nothing else (AC-3.2).

### 3.4 `ToolContext` / `RunContext` / `ToolDefinition` additions (`src/coordinator/tools/types.ts`, `agent.ts`)
```ts
interface CompanyAuthoringHost {                         // injected; tests fake all of it
  defaultVaultPath: string                               // from the host request; the base of "<parent>\Empresas\"
  folderHasFiles(path: string): Promise<boolean>         // fs shell: exists and holds any entry
  initVault(path: string): Promise<void>                 // the existing vault.init behavior, extracted from index.ts
  save(change: { companies: Company[]; agents: AgentProfile[]; vaults?: string[]; routines?: Routine[] }): void   // patchSettings(...), the saveRoutines pattern
  calls: { create: number }                              // per run; created once per run in index.ts (AC-5.9)
}
ToolContext.authoring?: CompanyAuthoringHost
ToolContext.reportAudit?(detail: Record<string, string | number | boolean | null>): void   // like reportText: the tool reports companyId, positions
RunContext.authoring?: CompanyAuthoringHost | null

ToolDefinition.validate?(input: I, ctx: ToolContext): Promise<void>   // throws ToolError; runs after the Zod parse, before preview/authorize (no card on failure)
ToolDefinition.previewRequired?: boolean                  // no preview => the call errors, no card (fail closed)
ToolDefinition.auditAction?: string                       // 'company.create' | 'company.edit'

export function offersCompanyAuthoring(run: { depth: number; unattended?: boolean; hasSeat: boolean; channel?: ThreadChannel }): boolean
// true iff depth === 0, not unattended, no company seat, and channel is undefined (desktop), 'telegram' or 'remote' (an allow-list, so a future channel is not offered by accident).
```
`appTools(ctx)` adds `...(ctx.authoring && offersCompanyAuthoring({...}) ? companyAuthoringTools : [])`. A call to a tool not in that list already fails as `tool.unavailable` before any approval (AC-1.2). Because the gate is on `thread.channel`, a phone-started run inside a WhatsApp or voice conversation does not get the tools (consistent with AC-1.3).

### 3.5 Approval, answer channel and audit
- `PendingApproval['preview']` gains `company?: CompanyProposalView`. `ApprovalBroker.respond(approvalId, decision, via?: AnswerChannel)`: records `via` (desktop IPC passes `desktop`, Telegram `telegram`, `ApprovalsFlow.answer` `phone`) and refuses an `allow` when `canAnswerFrom(via, approval, limit)` is false. `Authorization` (allowed or denied) gains `via?: AnswerChannel`, read by `executeTool`.
- `ApprovalView.whole: boolean` (phone). `ApprovalsFlow.answer` returns `already-answered` for an `allow` on a not-whole approval, without calling the broker (the broker refuses it anyway; two layers, one predicate).
- `texts.ts`: `approvalPrompt` returns the "see it on the desktop" text instead of the cut JSON when `canAnswerFrom` is false; `askApproval` in `telegram.ts` omits Permitir in that case (see G-6 for Rechazar).
- Audit: `toolTrail` takes an optional `{ action, detail }` override. For tools with `auditAction`, every outcome (`ok`, `denied`, `error`) is recorded as `company.create` or `company.edit` with `detail: { companyId?, positions, via? }` instead of the generic `tool.authorize` / `tool.run` pair. The detail is a closed list of scalars built from counts and ids; nothing is copied from the input, so `name`, `instructions` and `mission` cannot reach it (003 BR-18, 022 BR-4). `redact()` still runs on strings.

### 3.6 i18n keys (both `es` and `en`, in the same task that first uses each)
| Dictionary | Keys |
|---|---|
| `tools.ts` | `toolLabel.create_company`, `toolLabel.edit_company`; `tool.company.created` (name, id, vault, positions list), `tool.company.invalid.<code>` — one per `CompanyIssue` code (§3.2), with params where the issue carries them; `tool.company.onlyOne` (second creation in a run); `tool.company.vaultFailed` (reason); `tool.company.noPreview`; edit keys after G-1 |
| `companies.ts` | `company.proposal.titleCreate`, `company.proposal.titleEdit`, `company.proposal.vault`, `company.proposal.budget`, `company.proposal.boss`, `company.proposal.boardBoss`, `company.proposal.instructions`, `company.proposal.tools`, `company.proposal.autoApprove`, `company.proposal.delegates`, `company.proposal.mcp`, `company.proposal.runsCommands` ("can run commands without asking"), `company.proposal.headerAdded`, `company.proposal.before`, `company.proposal.after`, `company.proposal.added`, `company.proposal.removed`, `toolstate.companyInvalid` if the existing `toolstate.invalidInput` does not read right |
| `channels.ts` | `chan.seeOnDesktop` (Telegram and phone text when the proposal does not fit), keeping `tg.allow` / `tg.deny` |
| `remote-client/i18n` | `approvals.seeOnPc` |
Model-read text (tool descriptions, header, `toolText` English half) is English and never goes through the `language` switch (BR-11, 025 BR-17).

## 4. Data and persistence
- No new file, key or format. A creation writes: the vault folder (created by `initVault`, with the welcome note when empty, as `vault.init` does today), then one `settings.patch` with `{ companies, agents, vaults }` (vaults = `[...new Set([...vaults, vault])]`). An edit patches `{ companies, agents }` plus `routines` and nothing else when a position is removed.
- The patch carries whole arrays built from `ctx.getSettings()` at run time (after the approval), not from the settings at call time, so an Equipos edit made while the card waited is not overwritten; the validators run again at that moment (name taken, 10 companies, path now occupied) and a failure there writes nothing.
- Order: `initVault` first, `save` second. If `initVault` throws, nothing is saved and the vault list is unchanged (AC-5.2). If `save` throws after `initVault`, an empty welcome folder stays; `buildCompany` has run, no company exists.
- Existing companies and files written by earlier versions are untouched. Companies made in Equipos are editable by `edit_company` (AC-3.12); legacy values above a ceiling are G-7.

## 5. Dependency injection
Everything the new code needs reaches it through `ToolContext.authoring` (§3.4). Tests fake: `initVault` (spy, can throw), `folderHasFiles`, `save` (spy), `defaultVaultPath`, `reportText`, `reportAudit`, `signal`, the fake `Provider` of `tests/agent.test.ts` for runs, the broker with a recorded `respond`, and an in-memory audit sink (`initAudit` on a temp dir, as `tests/tool-trail.test.ts` does). `riskOf` is passed to `proposalOfCreation`; `shared` never imports the tool catalogue. The tool catalogue for AC-6.3 is `BUILTIN_TOOLS` from `shared/defaults` (the list Equipos offers), passed in as `catalogue` (see G-3).

## 6. Test strategy
Files: S=`tests/company-authoring.test.ts` (shared rules and builder), T=`tests/company-tools.test.ts` (tools, gate, run, audit), A=`tests/company-approval.test.ts` (authorize, broker, channels), plus the existing `tests/telegram.test.ts`, `tests/remote-approvals.test.ts`, `tests/i18n*.test.ts`. Titles read `AC-x.y (029) ...`.

| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1 | T → `AC-1.1 (029) offers both tools to an attended depth-0 run without a seat on desktop, telegram and remote` | any non-company agent id; settings with no agents beyond the default |
| AC-1.2 | T → `AC-1.2 (029) a company agent is not offered the tools and a forced call is refused with no approval` | model calls anyway: `tool.unavailable`, `approvals.pending()` empty, `save` not called |
| AC-1.3 | T → `AC-1.3 (029) voice and whatsapp threads are not offered the tools` | a phone-started run in a WhatsApp or voice thread; a future unknown channel string |
| AC-1.4 | T → `AC-1.4 (029) sub-agents and unattended runs are not offered the tools` | depth 1; `unattended: true` (routine, house rule, company task) |
| AC-2.1 | S → `AC-2.1 (029) the proposal lists every field of every position`; T → `AC-2.1 (029) nothing exists until the answer` | spies: `initVault` and `save` not called while the approval is pending; 8 positions; instructions 2000 characters, shown in full |
| AC-2.2 | S/T → `AC-2.2 (029) ...` **blocked G-1** | before/after for every field, a removal, an addition |
| AC-2.3 | A → `AC-2.3 (029) publish tools always ask in every mode and cannot be remembered` | modes needs-approval, auto-review (reviewer would allow), always-allow; tool listed in `alwaysAllowTools`, in the agent's `autoApproveTools` and in `ctx.autoApprove`; decision `always` returns allowed once and `rememberAlwaysAllow` is not called; `allowAlways` is false on the request |
| AC-2.4 | A → `AC-2.4 (029) read-only mode denies without asking` | `approvals.pending()` empty; `save` not called |
| AC-2.5 | A → `AC-2.5 (029) a denial changes nothing and tells the model not to retry` | state `denied`; result text is the `rejectedByYou` denial |
| AC-2.6 | A → `AC-2.6 (029) stopping the run while pending denies with Cancelado` | abort signal during the wait |
| AC-2.7 | A → `AC-2.7 (029) a restart while pending leaves nothing and the dangling call is closed` | history ending in the `tool_use`; `repairDanglingToolUses` closes it; `save` never called |
| AC-2.8 | `tests/telegram.test.ts` → `AC-2.8 (029) company tools ask only the bound chat, with Permitir and Rechazar and no Siempre, and create on Permitir` | an unbound chat's callback does nothing; `allow` from the bound chat reaches `respond` with `via: 'telegram'` |
| AC-2.9 | `tests/remote-approvals.test.ts` → `AC-2.9 (029) the phone answers only with approve on, never always` | scope off: list is empty and the approval stays pending for the desktop; the schema still has no `always`. Not blocked: 026 is `implemented` and the phone approvals exist (004 AC-12.x tests are in this file) |
| AC-2.10 | A → `AC-2.10 (029) no boss review for these tools` | `provider.review` never called; exactly one card |
| AC-2.11 | S → `AC-2.11 (029) a position auto-approving an exec tool is flagged` (pure part); card [manual] | `run_command` in `autoApprove` flags; a read tool does not; a `publish` tool does not (it still asks) |
| AC-2.12 | S → `AC-2.12 (029) canAnswerFrom is false for telegram and phone when the input does not fit`; A → `... the broker refuses allow from them`; Telegram and phone tests for the text | input of exactly 1500 and 1501 characters; `deny` still answers; the desktop still answers; other tools keep the old 1500 cut and the buttons |
| AC-3.1 | T → `AC-3.1 (029) approval initialises the vault then saves company, agents and vault list` | order of calls; `companyId` on every agent; reports wired by id; vaults deduplicated. Sidebar/Equipos refresh is `settings.patch` plumbing, covered by the manual run |
| AC-3.2 | T → `AC-3.2 (029) the result carries name, id, member ids and vault only` | exact-string assertion; no instructions or tools echoed |
| AC-3.3 | S → `AC-3.3 (029) the form and the tool build the same company` | each of the three templates and a custom list; ids normalised; `existing.length` offsets the names |
| AC-3.4 | [manual] | Check after creating one from chat |
| AC-3.5 | T → `AC-3.5 (029) the saved change is only companies, agents and vaults` | no tasks, meetings, routines, usage |
| AC-3.6 | S → `AC-3.6 (029) omitted budget is 20 and omitted vault is the default path` | explicit budget 100 accepted; name with `\ / : * ? " < > |` in the default path |
| AC-3.7 | S → `AC-3.7 (029) a free-form position list is built as given` | one position; chain of four; a position with `allowMcp: true` and `canDelegate: true` |
| AC-3.8 | S → `AC-3.8 (029) mailbox is empty and WhatsApp off` | |
| AC-3.9 to AC-3.14 | S/T → `AC-3.x (029) ...` **blocked G-1** | 3.10: self-report, report to a subordinate, unknown company, unknown position; 3.13: removing a head with two reports (two heads), removing the only position, reports and dotted lines re-pointed, routines of the position removed, vault files untouched; 3.14: extra keys `vault`, `email`, `whatsapp`, `secret` fail |
| AC-4.1 | T → `AC-4.1 (029) no deletion path exists` | `create_company` and `edit_company` strict schemas reject `delete`, `remove_company`, `trash`; `appTools` names contain no company-deletion tool; the only removal reachable is a position (AC-3.13) |
| AC-5.1 | T → `AC-5.1 (029) invalid creation is rejected before any card` | boss not a position, loop, unknown tool, malformed field, wrong types; no card, no write |
| AC-5.2 | T → `AC-5.2 (029) a vault that cannot be initialised saves nothing` | `initVault` throws (path, permission, disk); result carries the reason; `save` not called |
| AC-5.3 | S → `AC-5.3 (029) vault folder rules` | `..` segments, forward slashes, mixed case `EMPRESAS`, trailing separator, UNC path, drive-relative `C:foo`, the `Empresas` root itself, characters in the name part, a non-empty folder, the main vault and another company's vault |
| AC-5.4 | S → `AC-5.4 (029) budget ceilings` | 0, 100.01, negative, NaN, 100 accepted; omitted keeps 20 / 0 |
| AC-5.5 | S → `AC-5.5 (029) at most 8 positions` | 8 passes, 9 fails; empty list fails (`positions.none`) |
| AC-5.6 | S → `AC-5.6 (029) exactly one head, at most 4 levels, no loops` | zero heads, two heads, self-boss, two-node loop, five levels, duplicate keys, a boss key that does not exist |
| AC-5.7 | S → `AC-5.7 (029) name, colour, mission and goals` | empty, 60 and 61 characters, case and spaces against an existing name, a colour outside the swatches, 500/501 and 1000/1001 |
| AC-5.8 | S → `AC-5.8 (029) description plus instructions at most 2000` | exactly 2000; 2001 split across both fields |
| AC-5.9 | T → `AC-5.9 (029) one creation per run and ten companies at most` | second call in the same run (also after a denied first, see G-5); 10 existing; edits are not counted |
| AC-6.1 | T → `AC-6.1 (029) what is saved is what the proposal showed` | the `run` input is deep-equal to the previewed input; saved tools, auto-approvals, delegation and MCP equal the proposal rows |
| AC-6.2 | T → `AC-6.2 (029) no house tools and publish still asks`; A → `... a listed publish tool still goes to boss then person` | agent with `instagram_publish` in `autoApprove` in a company seat: authorize still asks (existing 007 BR-18 path) |
| AC-6.3 | S → `AC-6.3 (029) an unknown tool name fails` | `create_company` as a position tool; `mcp__x__y`; empty string; case variants |
| AC-6.4 | T → `AC-6.4 (029) audit entry per outcome with ids and counts only` | `ok`, `denied`, `error`; the serialised line contains neither the name, the instructions nor the mission; `via` is desktop/telegram/phone when someone answered (G-4 for the other cases) |
| AC-6.5 | S → `AC-6.5 (029) the brief header precedes the instructions` **blocked G-2** (wording); the "header added" row of the card is covered by AC-2.1's test | |
| AC-6.6 | S → `AC-6.6 (029) agents are meta / default model / medium` | an input that tries `provider`, `model`, `effort` fails the strict schema |
| AC-6.7 | S → `AC-6.7 (029) names come from AGENT_NAMES through pickName`; T → `... the tool description asks for the app language and does not change with it` | all 8 names; more positions than names are not reachable (max 8) |
| AC-7.1 | `tests/i18n.test.ts` (existing parity) + T → `AC-7.1 (029) both dictionaries have the labels and proposal texts`; look [manual] | description text identical in es and en runs |

Pure logic extracted from the UI (the builder, the vault default path, the proposal, the flag) is in `shared` and tested there; `TeamsSettings.tsx` and the cards have no component tests (typecheck, lint, a manual run via the `run` skill).

## 7. Security and privacy impact
- **Risk class:** `create_company` and `edit_company` are `publish` (BR-3, BR-26): every call asks, no "Siempre permitir" (the request carries `allowAlways: false`), not skippable by "Permitir todo", per-agent auto-approve or auto-review, denied in "Solo lectura". No boss step (AC-2.10).
- **Confinement:** the strict Zod schema, the `COMPANY_LIMITS` ceilings and the vault-path rules run before the card and again after the answer. The vault is under `<parent of default vault>\Empresas\`, never an existing non-empty folder. Mailbox, WhatsApp and secrets have no field (BR-21). No deletion path (AC-4.1).
- **Informed yes:** the card shows every tool, auto-approval, delegation and MCP flag, the instructions in full, and a flag for any auto-approved `exec` tool; the saved agent equals what was shown (AC-6.1); a missing preview aborts the call (`previewRequired`).
- **Prompt injection:** the instructions become a system prompt of agents that later run alone, behind a fixed header saying they are the person's brief and cannot override approvals or tool rules (BR-15; wording G-2). The header does not stop an over-broad grant: the person's reading of the card is the one guard inside the ceilings (spec §7, "what remains uncovered").
- **Channels:** Telegram answers only for the bound private chat; Telegram and the phone never answer "always" and never get Permitir for a proposal they cannot show whole (BR-23); the phone also needs the approve scope. One predicate and the broker enforce it.
- **Secrets / third parties:** none new. The proposal is text already in the conversation, so it reaches no provider it did not already reach; `PRIVACY.md` unchanged unless implementation shows otherwise.
- **Audit:** `company.create` / `company.edit`, actor `agent`, ids and counts only.
- **Docs in the same PR** (tasks T33-T36): `docs/security/CONTROLS.md` (new row "Companies created and edited by Alma: `publish` confirmation, ceilings, no deletion, no always" next to the human-approval row, and the evidence tests); `docs/security/RISKS.md` (next free R-id, R-15 today: privilege escalation by a free-form grant, injection into persistent system prompts, cost, folder creation, `edit_company` escalation; compensating controls; residual: the reader of the card); `docs/modules/approvals.md` (the `publish` table at line 81 gains the two tools; the Telegram/phone whole-input rule; the answering channel); `docs/modules/companies.md` (second creation path, no deletion, limits); `docs/modules/telegram.md` and `docs/modules/remote-access.md` (the "see it on the desktop" behavior); `docs/modules/agents.md` (app-tools list). The amendments listed in spec §3 to 007, 004, 010, 003, 015 and 022 are applied when the code lands (T36), not before.

## 8. Rollout
No flag and no new setting: the spec defines none. The tools exist as soon as the build has them, for every non-company agent answering a person on desktop, Telegram or the paired phone. How to switch them off today: approval mode "Solo lectura" denies them; there is no per-feature off switch (G-8 asks if one is wanted). First run: nothing visible changes until the person asks Alma for a company; Equipos behaves as before (AC-3.3). The `settings.patch` path is the same one routines already use, so no migration.

## 10. Coordination with 030 (chat attachments)
030 is planned in parallel and edits the same files: `src/coordinator/agent.ts` (`appTools`, `RunContext`, the `toolContext` in `executeTool`), `src/coordinator/tools/types.ts`, `src/shared/types.ts`, `src/shared/i18n/{es,en}/tools.ts` (and `chat.ts` / `companies.ts` / `channels.ts`), `src/coordinator/index.ts`, `ToolCard.tsx`, `lib/format.ts`, `docs/security/*`, `docs/modules/agents.md`. Sequence: **029 lands first**, 030 rebases on it. The full list and the merge cautions are at the end of `tasks.md`.

## 9. Gaps and contradictions found (not decided here)
| Id | Where | The question | Effect in this plan |
|---|---|---|---|
| G-1 | BR-26, AC-3.9 to AC-3.14, AC-2.2 | `edit_company`: which fields a patch may change (name, colour, mission, goals, budget, per-position title/description/instructions/tools/auto-approvals/delegation/MCP/boss/budget, dotted lines?); how Alma refers to an existing company and position; how she learns their ids (no list tool is specified); order of effects when one patch both removes a position and re-points reports | All edit tasks are `blocked`. The pure org-chart rules they share with creation are not. |
| G-2 | BR-15, AC-6.5, AC-3.3 | The wording and language of the fixed header, and whether an edit that changes instructions re-adds it. Also AC-3.3 ("same company from form and tool") vs AC-6.5 (header only on tool-made positions) | Header applied by the tool layer, not by `buildCompany`, so AC-3.3 and 007 AC-1.1 hold. Wording task `blocked`. |
| G-3 | AC-3.6, AC-3.7, AC-6.3, BR-13 | Creation input details the spec does not state: is `color` optional (the builder's default `COMPANY_COLORS[n % 8]` is the form's existing rule), are `mission` and `goals` optional, does `create_company` accept a template id (AC-3.3 mentions "template"), what "the tool catalogue" is (plan reads it as `BUILTIN_TOOLS`, so `email_send`, `send_whatsapp`, MCP names are rejected), must `autoApproveTools` be a subset of `tools`, may Alma set dotted lines (the card in AC-2.1 shows none, so none are offered) | Plan follows the narrowest reading; the schema in §3.3 shows it. |
| G-4 | BR-14, AC-6.4 | "The main vault" is not defined in `docs/context.md`: the default `Documents\Alma\Vault`, the active vault, or both. For the audit: what `companyId` and channel mean when nothing was created or nobody answered (read-only mode, cancelled, restart) | Vault check receives a `reserved` list; the shell passes the default vault, `settings.activeVault` and every company vault (a superset). Audit omits `companyId` / `via` when none exists. |
| G-5 | AC-5.9, BR-19 | "A second `create_company` call in the same run": does it count calls, validated calls, or created companies (e.g. after a denial or a validation error, may the model try again once)? | Plan follows the literal text: the second call in a run, whatever happened to the first. |
| G-6 | AC-2.12, BR-23 | Does Rechazar stay on Telegram and the phone when Permitir is hidden? Also a consequence to confirm: with 8 positions and 2000 characters each, almost every real creation exceeds 1500 characters, so Telegram and the phone will mostly say "see it on the desktop" | Plan keeps Rechazar (only Permitir is removed, per the literal text). |
| G-7 | AC-5.5, AC-5.6, AC-5.4 | Only budgets say an untouched legacy value stays as is. For a company made in Equipos with more than 8 positions or more than 4 levels, does an edit that does not add positions or depth pass, and does a rename collide with a legacy duplicate name | Part of the blocked edit tasks. |
| G-8 | §8 | Whether the person wants a setting to turn the tools off | None added. |
| G-9 | BR-11, AC-6.7 | Static English tool description vs "asks for the app `language`": satisfied by pointing at the reply-language rule already in the system prompt | Plan uses that reading; confirm. |
