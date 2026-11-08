---
status: draft
---

# 029 — Alma creates and edits companies

## 1. Summary
Today a company (a team of agents with an org chart, a vault, a budget) can only be created and edited by hand in Configuración → Equipos. This spec lets the person ask Alma, in an ordinary chat on the desktop, on Telegram or on the paired phone, to set one up or to change one: Alma designs the org chart (any positions she thinks fit, with their tools), shows the person exactly what would be created or changed in a native approval card, and only after the person allows it do the company, its agents and its vault folder exist or change. The result is the same kind of company Equipos makes, editable afterwards in Equipos. Alma can create and edit companies; she can never delete one. Alma here means the agent answering in a normal thread; it is not a member of any company. Two new tools do this: `create_company` and `edit_company`, both `publish`.

## 2. Problem and goal
Setting up a team means picking a template, naming it, choosing a folder and then editing each position by hand, in a settings screen far from the conversation where the person described the business. Done means: the person describes the business in chat, Alma turns it into a company (or changes one) after an explicit yes, nothing is created or changed before that yes, the person sees every tool and auto-approval granted before saying yes, and nothing Alma can do removes a company.

## 3. Scope
**In:**
- App tools `create_company` and `edit_company`, offered to Alma and never to company agents.
- The confirmation before anything is written, as the native approval card of a `publish` tool, and how it is answered on the desktop, Telegram and the paired phone.
- Limits on what Alma may set (budget, positions, shape, vault, names, texts) and on how often.
- Moving the creation logic that `TeamsSettings.tsx` runs inside `NewCompany.create()` into one shared, pure place used by both the Equipos form and the tools (see §7).
- Audit and `docs/security/` entries for the new capability.

**Out (and why):**
- Deleting a company: not allowed to Alma (BR-7). Deleting stays a manual action in Configuración → Equipos (007 AC-2.12).
- Company mailbox, WhatsApp number and their secrets: never touched by Alma (BR-21).
- Giving a company its first tasks or meetings: company tooling for members, not for Alma (007).
- Changes to the company engine, budgets, org-chart rules, task and meeting rules: `../007-companies/spec.md` unchanged.
- The approval mechanics (modes, card, boss review, Telegram buttons): `../004-approvals/spec.md`, `../010-telegram/spec.md`; this spec only says how the new tools use them.
- The phone's pairing, scopes and transport: `../026-remote-access/spec.md` and `../028-remote-vault-and-threads/spec.md`; the phone part depends on them being implemented (§7). Neither is amended.
- Voice and WhatsApp threads, sub-agents and unattended runs (BR-8, BR-24).

**Amends (the existing specs are not edited here; each amendment is applied when this spec is implemented):**
- `007-companies`:
  - §1 last sentence and §3 In (UI bullet): "teams are created and edited in Configuración → Equipos" gains a second path, the two tools.
  - AC-1.1 and AC-1.3: the creation they describe becomes a shared function that also accepts an explicit position list; the Equipos form behavior is unchanged.
  - AC-2.11: removing a position is also reachable through `edit_company`, with a confirmation.
  - AC-2.12: unchanged, and now explicitly the only way to delete a company.
  - AC-4.1: its inverse is added (the new tools exist only for agents that are not in a company).
  - AC-4.10: the seven company tools are unchanged; the new tools are not among them.
  - BR-16: the source of "USD 20" moves from `TeamsSettings.tsx` to the shared builder; BR-17: `allowMcp` false stays the default of Equipos, while Alma may set it true.
  - §7 Tools and risk: the two new `publish` tools are listed.
- `004-approvals`: AC-5.3 and BR-4 (the list of `publish` tools gains `create_company` and `edit_company`); BR-15 and AC-12.1 (the 1500-character cut of approval text on Telegram and on the phone: for these tools BR-23 applies).
- `010-telegram`: AC-6.1 (the approval message for these tools follows BR-23 when the input does not fit).
- `003-agents` BR-18 and `015-file-and-command-tools` BR-12: the app-tools list gains the two tools; the audit of non-read tools applies, with the dedicated actions of BR-19.
- `022-security-and-privacy`: `docs/security/CONTROLS.md` and `RISKS.md` (§7); BR-4 unchanged (the new audit entries carry no names, instructions or mission).
- `docs/context.md`: the Tool risk term (done).
- `026-remote-access`, `028-remote-vault-and-threads`: not amended; the tools are offered in the phone's threads and approved under 004 AC-12.1 to AC-12.3.

## 4. Users and stories
- **US-1** As the person, I want to ask Alma in a chat to set up or change a company, so that I don't have to go to Configuración → Equipos and fill a form.
- **US-2** As the person, I want to see exactly what will be created or changed, including every tool and auto-approval, and answer yes or no before anything exists, so that a misunderstanding costs nothing.
- **US-3** As the person, I want a company made by Alma to be indistinguishable from one made in Equipos, so that I can edit it there.
- **US-4** As the person, I want Alma never to be able to delete a company, so that a chat can add or adjust work but not destroy it.
- **US-5** As the person, I want to answer the approval from wherever I am talking to Alma (desktop, Telegram, phone) without ever granting a permanent "always allow", so that a long-lived permission is never created by accident.
- **US-6** As the maintainer, I want the creation rules in one pure function used by the form and the tools, so that they cannot drift and are testable without a model.
- **US-7** As the person, I want bounds on what a chat can set (budget, number of positions, folder, sizes) and on how often, so that a mistaken or injected proposal cannot go far.

## 5. Acceptance criteria
Tags: `[gap]` = testable, no test yet; `[manual]` = checked by hand.

### Offering the tools (US-1)
- **AC-1.1** (US-1) Given a run of an agent at depth 0 in a thread with no company seat, in a desktop, Telegram or paired-phone thread, answering a person (not unattended), when the tool list is built, then `create_company` and `edit_company` are offered, whichever non-company agent it is. [gap]
- **AC-1.2** (US-1) Given a run of a company agent, when the tool list is built, then these tools are not offered; if the model calls one anyway, the call is refused as a tool that is not offered (004 AC-2.9), no approval is requested and nothing changes. [gap]
- **AC-1.3** (US-1) Given a voice or WhatsApp thread, when the tool list is built, then these tools are not offered. [gap]
- **AC-1.4** (US-1) Given a delegated sub-agent (depth above 0) or an unattended run (routine, house rule, company task), when the tool list is built, then these tools are not offered. [gap]

### Confirmation before anything exists or changes (US-2, US-5)
- **AC-2.1** (US-2) Given a valid creation call, when it is authorized, then the approval card shows, before any write, the company name, the vault folder, the monthly budget, and for every position its title, its boss, its instructions in full, its tools, its auto-approved tools, whether it can delegate and whether MCP is on; and until the person answers, no company, agent, vault folder or vault entry exists. [gap]
- **AC-2.2** (US-2) Given a valid edit call, when it is authorized, then the approval card shows each change as before and after (and any position added or removed), and until the person answers nothing is changed. [gap]
- **AC-2.3** (US-2) Given the tools are `publish` (BR-3), then in the modes "Pedir aprobación", "Auto-review" and "Permitir todo" every call asks the person; no per-tool "Siempre permitir" rule, no agent auto-approve list and no auto-review model can skip the question; the card has no "Siempre permitir" and an answer of "always" counts as a single allow that is not remembered (004 BR-4). [gap]
- **AC-2.4** (US-2) Given approval mode "Solo lectura", when one of these tools is called, then it is denied without asking and nothing changes. [gap]
- **AC-2.5** (US-2) Given the person denies, then nothing is created or changed, the tool state is `denied`, and the model is told not to retry the same action (004 BR-14). [gap]
- **AC-2.6** (US-2) Given the run is stopped while the confirmation is pending, then it is denied with note "Cancelado" and nothing changes. [gap]
- **AC-2.7** (US-2) Given the app closes or restarts while the confirmation is pending, then nothing changes and the dangling call is closed with an error result on the next message (002 AC-1.7). [gap]
- **AC-2.8** (US-5) Given the call comes from a Telegram thread, when the approval is requested, then it goes to the allowed Telegram user only, with the Permitir and Rechazar buttons and without the "Siempre" button, and the company is created or changed only on Permitir. [gap]
- **AC-2.9** (US-5) Given the call comes from a paired-phone thread, when the approval is requested, then the phone can answer it only while its approve scope is on; with the scope off the phone sees nothing and the approval stays pending for the desktop or Telegram; the phone never answers "always" (004 AC-12.1 to AC-12.3). [gap] Depends on 026/028 being implemented.
- **AC-2.10** (US-2) Given a call made by Alma, then there is no boss step: Alma is not a company agent, so only the person is asked (the boss-then-person chain of 007 AC-9.6 applies to company agents' `publish` calls, not to these tools). [gap]
- **AC-2.11** (US-2) Given the card of a creation or an edit, then it is read-only (Permitir / Rechazar; to change anything the person says so in the chat and Alma proposes again), and any position whose auto-approved tools include an `exec` tool carries the flag "can run commands without asking". [manual] Check with a position that auto-approves `run_command`.
- **AC-2.12** (US-5) Given a call from Telegram or the phone whose approval input does not fit entirely in the channel's text (the 1500-character cut of 004 AC-12.1 and 010 AC-6.1), then that channel does not offer Permitir: it says to see it on the desktop, the approval stays pending, and the desktop card (complete) can still answer it. [gap]

### Creation (US-1, US-3)
- **AC-3.1** (US-1, US-3) Given the person approves a creation, then the vault folder is initialised, the company is saved with its members and bosses wired, one agent per position is saved with `companyId` set, the vault is added to the known vaults, and the company appears in the Empresas sidebar and in Equipos without restarting. [gap]
- **AC-3.2** (US-1) Given the creation succeeded, then the tool returns to the model the company name and id, each position with its member id, and the vault path, and nothing else. [gap]
- **AC-3.3** (US-3, US-6) Given the same template or position list, name, vault, colour choice and the same existing companies, when the Equipos form and the tool build the company, then they produce the same company and the same agents apart from generated ids. Equipos behavior in 007 AC-1.1 and AC-1.3 is unchanged. [gap]
- **AC-3.4** (US-3) Given a company made by Alma, then its agents are hidden from the generic agent lists and from the Chat tab, and its conversations live under Empresas (007 AC-2.13). [manual] Check after creating one from chat.
- **AC-3.5** (US-3) Given a company just created, then no task, meeting, routine or run exists and nothing has been spent, exactly as after creating one in Equipos. [gap]
- **AC-3.6** (US-1) Given Alma sets the budget, the vault folder or the positions in the call, then the company is created with those values (within the limits of AC-5.3 to AC-5.6); when she omits the budget it is USD 20 and when she omits the vault it is the default path of 007 AC-1.2. [gap]
- **AC-3.7** (US-1) Given positions that Alma designs freely (any titles, any reporting lines, not a template), then the company is created with exactly those positions, each with an agent built by the shared builder from the position's description, instructions, tools, auto-approved tools, `canDelegate` and `allowMcp` as given. [gap]
- **AC-3.8** (US-3) Given a company created by these tools, then `email.address` is empty and WhatsApp is off, as after Equipos creation. [gap]

### Editing (US-1, US-3)
- **AC-3.9** (US-1) Given the person approves an edit, then exactly the listed changes are applied to the company and its agents in settings, nothing else changes, and the Empresas and Equipos views show the result without restarting. [gap]
- **AC-3.10** (US-1) Given an edit that moves a position, then it is refused at validation, with no card, when it would make a position report to itself or to someone below it (007 BR-2); an edit naming an unknown company or an unknown position is refused the same way. [gap]
- **AC-3.11** (US-1) Given an edit call, then it carries a patch of named changes and asks one confirmation for the whole call (never one per change). [gap]
- **AC-3.12** (US-1, US-3) Given an edit naming any company in settings, including one created in Equipos, then it is accepted (subject to the other rules). [gap]
- **AC-3.13** (US-1) Given an edit that removes a position, then the card lists the removal; once approved the position's agent and routines are removed, its reports pass to its boss and it disappears from dotted lines (007 AC-2.11); the vault files are not touched. An edit that would leave the company with no head or with more than one head is refused at validation. [gap]
- **AC-3.14** (US-1) Given an edit input that includes a vault folder, a mailbox, a WhatsApp setting or a company secret, then it fails validation (the edit schema has no such fields) and nothing changes. [gap]

### No deletion (US-4)
- **AC-4.1** (US-4) Given the tools Alma has for companies, then none of them can delete a company, delete its vault files, or delete its conversations, tasks or meetings; an input that asks for any deletion fails validation, no card is shown and nothing changes. (Removing one position through an edit is not deleting a company: AC-3.13.) [gap]

### Limits and validation (US-2, US-7)
- **AC-5.1** (US-2) Given a creation input that fails validation (a boss that is not a position, a reporting loop, an unknown tool name, a malformed field), when the call is validated, then it is rejected with a tool error, no card is shown and nothing is created. [gap]
- **AC-5.2** (US-1) Given the vault folder cannot be initialised (invalid path, no permission, disk error), when the person has approved, then the tool returns an error with the reason, no company and no agent are saved and the vault list is unchanged. [gap]
- **AC-5.3** (US-7) Given a vault folder outside `<parent of the default vault>\Empresas\`, or containing the characters `\ / : * ? " < > |` in the company-name part, or that already exists with files in it, or that is the main vault or another company's vault, then the call fails validation before any card. [gap]
- **AC-5.4** (US-7) Given a company budget or a per-member budget above USD 100, or set to 0 by Alma, then the call fails validation; an omitted company budget is USD 20 and an omitted per-member budget keeps 0 (only the company cap, as today). An edit that does not touch a budget leaves an existing value (even 0 or above USD 100) as it is. [gap]
- **AC-5.5** (US-7) Given more than 8 positions in a creation (or an edit that would leave more than 8), then the call fails validation. [gap]
- **AC-5.6** (US-7) Given positions that do not have exactly one head (a member with no boss, reporting to the board), or a chain of more than 4 levels, or a reporting loop, then the call fails validation. [gap]
- **AC-5.7** (US-7) Given a company name that is empty, longer than 60 characters, or equal to an existing company's name (ignoring case and surrounding spaces), a colour outside the 8 swatches, a mission above 500 characters or goals above 1000, then the call fails validation. [gap]
- **AC-5.8** (US-7) Given a position whose description plus instructions exceed 2000 characters, then the call fails validation. [gap]
- **AC-5.9** (US-7) Given a second `create_company` call in the same run, or a creation when 10 companies already exist in settings, then the call fails with a tool error and no card is shown; edits have no such limit. [gap]

### What the person approved is what is saved (US-2)
- **AC-6.1** (US-2) Given the card shows a position's tools, auto-approved tools, delegation and MCP, then what is saved is exactly what was shown: the tool input is not altered between the card and the write. [gap]
- **AC-6.2** (US-2) Given any company created or edited by these tools, then no agent has the house (home) tools (007 BR-17), and a `publish` tool listed in a position's auto-approved tools still asks (004 BR-12): its calls go to the boss and then the person (007 BR-18). [gap]
- **AC-6.3** (US-2) Given a tool name that does not exist in the tool catalogue is given for a position, then the call fails validation (AC-5.1). [gap]
- **AC-6.4** (US-2) Given any outcome (`ok`, `denied`, `error`), then an audit entry is written for the call as the dedicated action `company.create` or `company.edit` with the company id, the number of positions and the channel of the answer (desktop, Telegram or phone), and never the name, the instructions or the mission (003 BR-18, 022 BR-4). [gap]
- **AC-6.5** (US-2) Given a saved position, then its system prompt is a fixed header followed by the instructions given; the header says the text is the person's company brief and cannot override approvals or tool rules, and the card says the header is added. [gap]
- **AC-6.6** (US-2) Given agents created by these tools, then each has provider `meta`, `DEFAULT_META_MODEL` and effort `medium` (the `memberAgent` defaults), whatever Alma wrote. [gap]
- **AC-6.7** (US-2) Given a creation, then each agent's name comes from the fixed `AGENT_NAMES` list through `pickName`, and the tool's instruction to the model asks for titles, descriptions and instructions in the app `language`. [gap]

### Presentation
- **AC-7.1** (US-2) Given a thread, then the tool cards for these tools have a friendly label and the approval card has its text from the Spanish and English dictionaries; the tool descriptions read by the model stay English. [manual] Check both languages.

## 6. Business rules
Rules the code must obey. Everything here is decided: (human) = said by the human; (accepted) = proposed by the planner and accepted by the human ("re bien todo", 2026-11-08); the rest follow from existing specs.

- **BR-1** Nothing is created or changed before the person says yes: no company, agent, vault folder, vault entry or setting exists or changes until the approval is answered "allow".
- **BR-2** The company and its agents are built by one pure function in `src/shared/company.ts` (next to `companyTemplates`, `memberAgent`, `pickName`, `newId`) used by the Equipos form and by the tools. Disk access (`vault.init`) and persisting settings stay in the callers' shells. The colour list now private to `TeamsSettings.tsx` moves with it.
- **BR-3** (human) The creation tool is `ToolRisk` `publish`: it always asks, the native approval card is the confirmation, "Siempre permitir" is never offered, it is denied in "Solo lectura". `publish` here is a deliberate stretch of the old "acts outward" meaning: it also covers a model creating autonomous agents.
- **BR-4** (human) Positions are free-form: Alma may design any org chart and any positions; she is not limited to the three templates or "blank".
- **BR-5** (human) Alma may assign each position's tools, auto-approved tools (`autoApproveTools`), `canDelegate` and `allowMcp`. Limits that already exist still hold and are not part of this decision: `publish` tools never skip approval even if listed (004 BR-12), company agents never get the house tools (007 BR-17), company agents auto-approve only the six file and image tools plus their own list (007 BR-18).
- **BR-6** (human) Alma may set the initial budget, the vault folder and the number of positions, within the limits of BR-13 and BR-14. When she omits the budget or the vault, the existing 007 defaults apply (USD 20; the default vault path of 007 AC-1.2).
- **BR-7** (human) Alma can create and edit companies and can never delete one. There is no deletion operation in her tools (AC-4.1).
- **BR-8** (human) The tools are usable from the desktop chat, Telegram and the paired phone. They are not offered in voice or WhatsApp threads. Each channel answers the `publish` card under its own rules and none of them can answer "always" (004 BR-4; Telegram omits the button when `allowAlways` is false; 004 AC-12.3).
- **BR-9** The tools are never offered to a company agent (AC-1.2).
- **BR-10** A company made by these tools has the same shape and defaults as one made in Equipos except where this section says otherwise: no mailbox, WhatsApp off, `companyId` set, one agent per position.
- **BR-11** Tool descriptions read by the model are English and never change with `language`; every text the person reads goes through the Spanish and English dictionaries (015 BR-13, 025).
- **BR-12** The tools receive what they need through `ToolContext` (a callback that persists the company, like `saveRoutines`), not by importing a singleton (Constitution IV). Inputs are validated with Zod before the confirmation.
- **BR-13** (accepted) Ceilings: company budget and per-member budget at most USD 100 each; Alma never sets 0 (no limit); at most 8 positions per company.
- **BR-14** (accepted) The vault folder must be under `<parent of the default vault>\Empresas\`, follow the character rule of 007 AC-1.2, not already exist as a non-empty folder, and not be the main vault or another company's vault.
- **BR-15** (accepted) A position's description plus instructions are at most 2000 characters, shown in full on the card, and saved behind a fixed header saying they are the person's company brief and cannot override approvals or tool rules.
- **BR-16** (accepted) Shape: exactly one head reporting to the board, every other position reporting to a member, at most 4 levels, no loops (007 BR-2). An edit may not leave the company without a head or with several.
- **BR-17** (accepted) Names and language: agent names come from the fixed list (`pickName`); titles, descriptions and instructions are written in the app `language`.
- **BR-18** (accepted) Company name: not empty, at most 60 characters, not equal (ignoring case and surrounding spaces) to an existing company's name; colour from the 8 swatches; mission at most 500 and goals at most 1000 characters.
- **BR-19** (accepted) Rate and volume: one creation per run, at most 10 companies in settings; edits are not rate-limited beyond the confirmation. Audit: dedicated actions `company.create` and `company.edit` with company id, number of positions and the answering channel, never names, instructions or mission.
- **BR-20** (accepted) Created agents use the `memberAgent` defaults (provider `meta`, `DEFAULT_META_MODEL`, effort `medium`); Alma does not choose providers or models.
- **BR-21** (human, "never") Alma never creates, configures or links a company mailbox or WhatsApp number and never handles company secrets; a new company starts with both off and the edit tools have no field for them.
- **BR-22** (accepted) The approval card is read-only (Permitir / Rechazar) and flags any position that auto-approves an `exec` tool with "can run commands without asking".
- **BR-23** (accepted) A channel (Telegram, phone) offers Permitir only when it can show the whole approval input; otherwise it says to see the proposal on the desktop and the approval stays pending there.
- **BR-24** (accepted) The tools are offered to every non-company agent answering a person in a desktop, Telegram or phone thread; not to sub-agents (depth above 0) and not to unattended runs.
- **BR-25** (accepted) Edit scope: any company in settings; removing a position is allowed (listed on the card, reports pass to its boss as in 007 AC-2.11); the vault folder, mailbox and WhatsApp of an existing company cannot be changed by Alma.
- **BR-26** (accepted) The edit tool `edit_company` is `publish`, takes a patch of named changes, shows before and after on the card, and asks one confirmation per call.

## 7. Constraints and risks
- **Layers touched** (see `docs/architecture.md`):
  - `shared`: the creation logic. What `TeamsSettings.tsx` calls today lives in the renderer: `NewCompany.create()` (lines 91-122) builds the `Company` (`newId('empresa')`, name, mission, goals from the template, `COLORS`, `budgetUsd: 20`, empty email, `whatsapp: false`), then one `newId('puesto')` per template position, `pickName(...)` with offset `5 × existing companies`, `memberAgent(...)`, and wires `reportsTo` once all ids exist; then the shell calls `request({ method: 'vault.init' })` and `onChange({ companies, agents, vaults })`. The pure part (everything except the two calls) moves to `shared/company.ts`, since `coordinator` cannot import `renderer` (Constitution IV) and `shared` is the only place both can reach. `companyTemplates`, `memberAgent`, `pickName`, `newId` and `AGENT_NAMES` are already there. The builder must now accept an explicit position list (free-form), not only a template. The validation rules of BR-13 to BR-18 and BR-25 are pure functions in `shared` too. The default-vault-path string rule (007 AC-1.2) is also pure and moves; reading the base folder (`window.desktop.defaultVaultPath()`) stays a shell concern.
  - `coordinator`: new tool files under `src/coordinator/tools/` exporting `ToolDefinition`s with `risk: 'publish'` and a `preview` (the card content), registered in `appTools` in `agent.ts` (today `...(ctx.company ? companyTools : [])` is the only company gate; the new tools are the inverse gate, plus the depth, unattended and channel gates of BR-24), and a persistence callback on `RunContext` / `ToolContext` backed by `patchSettings({ companies, agents, vaults })` in `index.ts` (the pattern `saveRoutines` uses; `main` already applies `settings.patch`). Vault initialisation reuses the existing `vault.init` handler. The Telegram and phone approval text follow BR-23.
  - `renderer`: `TeamsSettings.tsx` calls the shared builder instead of its inline copy; `lib/format.ts` gets the tool labels; the approval card shows the proposal (already supports a `preview`) and the flag of BR-22.
  - `main`: no new IPC expected; plan must confirm that `settings.patch` accepts `companies`, `agents` and `vaults` and that nothing in `main/guard.ts` blocks it.
- **Dependencies:** the Telegram part uses the existing approval buttons (`ap:<id>:<decision>`, no "always" when `allowAlways` is false). The phone part depends on 026 (remote channel, approve scope) and 028 (phone conversations) and on 004 AC-12.1 to AC-12.3 being implemented; until then the tools work on desktop and Telegram and AC-2.9 is not testable.
- **Security / privacy (honest account of the decision).** The human decided that the model (Alma) designs free-form positions and assigns their tools, auto-approvals, delegation and MCP, and sets the budget and vault. That is a model creating persistent, autonomous agents with whatever capabilities it names. The risks are: (1) privilege escalation: a position given `run_command` (an `exec` tool) and listing it in `autoApproveTools` runs shell commands on the PC with no question at all, and the boss-then-person chain applies only to `publish` tools, not to `exec`; with MCP on, MCP tools (risk `exec`) are available too; (2) prompt injection: the proposal is written by a model that may have read web pages, mail or files in the same conversation, and the position instructions become the system prompt of agents that later run alone; (3) cost: Alma chooses the budget (within the ceiling of BR-13) and each position is an agent that can spend; (4) a folder is created where the chosen vault path points (confined by BR-14); (5) `edit_company` can escalate an existing company the same way. **Controls that already exist and compensate in part:** the calls are `publish`, so they always ask, cannot be remembered, cannot be skipped by "Permitir todo" and are denied in "Solo lectura"; the card shows every tool, auto-approval, delegation and MCP flag and what is shown is what is saved (AC-2.1, AC-6.1), so the person's yes is informed, with an explicit flag for auto-approved `exec` tools (BR-22); `publish` calls made by company agents themselves (mail, WhatsApp, Instagram, secure home) always go to the boss and then the person (007 BR-18) and are never auto-approved; company agents never get the house tools and work with the company vault as working folder; "Solo lectura" still blocks company agents' auto-approved tools; monthly budget caps pause agents at 100 % and warn at 80 % (007 BR-16, AC-8.x); the ceilings of BR-13, BR-14 and BR-16, the instruction cap and header of BR-15 and the rate limits of BR-19 bound what a mistaken or injected proposal can do; no deletion path exists (AC-4.1); Telegram and the phone never answer "always" and never approve what they cannot show whole (BR-23); every call is audited. **What remains uncovered:** the person's reading of the card is the only guard against an over-broad grant inside the ceilings (for example a position with `run_command` auto-approved); the flag of BR-22 draws attention to it but does not prevent it. **`docs/security/` updates required in the same PR:** `CONTROLS.md` (a control for the `publish` confirmation of company creation and editing, what the card shows, the ceilings, no deletion, no "always"), `RISKS.md` (the risks above with the compensating controls and the residual risk); `PRIVACY.md` only if the proposal text reaches a provider it did not already reach (it should not: it is already in the conversation); also `docs/modules/approvals.md` and the companies module page that list the `publish` tools or describe how companies are created.
- **Performance / platform:** Windows paths for vaults (`\ / : * ? " < > |` replaced by `-`, 007 AC-1.2); creation is a handful of file and settings writes, no model call of its own.

## 8. Open Questions
None — all resolved on 2026-11-08, defaults accepted by the human.
