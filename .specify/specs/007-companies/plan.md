# 007 — Plan

## 1. Approach
A company is data (members with `reportsTo` and `collaborates`, a vault, a budget) plus a `CompanyEngine` in the coordinator. The engine does not poll models: a 30 s timer and every state change only look for something concrete (a `todo` task whose assignee is free and under budget, a delivery awaiting review, a meeting whose preparation time arrived) and start one run for it. Work moves through seven agent tools; the org-chart and cost rules are pure functions in `shared`; the engine takes every side effect (running an agent, one model call, writing a note, notifying, emitting) as an injected dependency, so the whole flow is tested with fake agents. Anything a company agent sends out is checked by its boss and then by the person, reusing the approval policy.

Rejected: agents that stay alive and loop on their own. They cost tokens all day and have no natural stop; [ADR 0015](../../../docs/adr/0015-companies-task-driven-wakeups.md) records the task-driven choice. The approval chain extends [ADR 0012](../../../docs/adr/0012-approval-model.md) instead of adding a second mechanism.

## 2. Layers touched
| Layer | Files | Why it lives there |
|---|---|---|
| shared | `src/shared/company.ts` (`chainOfCommand`, `subordinates`, `directReports`, `colleagues`, `canReportTo`, `head`, `PRICES`, `costOf`, `monthKey`, `COMPANY_TEMPLATES`, `memberAgent`, `pickName`), `src/shared/types.ts` (`Company`, `CompanyMember`, `CompanyTask`, `Meeting`, `CompanySnapshot`, requests and events), `src/shared/defaults.ts` | pure rules used by the engine, the tools and the editor |
| coordinator | `src/coordinator/company/engine.ts` (`CompanyEngine`), `src/coordinator/company/store.ts` (`CompanyStore`), `src/coordinator/tools/company.ts` (`companyTools`), `src/coordinator/agent.ts` (seat, company context, `COMPANY_AUTO_APPROVE`), `src/coordinator/approval.ts` (boss review), `src/coordinator/index.ts` (engine wiring, company WhatsApp, requests) | agents run, files are written and models are called only here |
| main | `src/main/settings.ts` (company mailbox passwords sealed), `src/main/index.ts` (`settings:setCompanySecret`) | secrets are sealed by main |
| renderer | `src/renderer/src/companies/CompaniesView.tsx`, `OrgChart.tsx`, `TeamsSettings.tsx`, `companies.css`, `src/renderer/src/App.tsx` (sidebar pane), `src/renderer/src/components/SettingsDialog.tsx` (Equipos tab) | board, chats, meetings, chart, activity, and the team editor |

`shared` imports nothing; the renderer talks to the engine only through `company.*` requests and the `company.changed` event.

## 3. Contracts
```ts
interface EngineDeps { settings(): Settings; store: CompanyStore; runMember(company, memberId, title, prompt, options?: { noAsk?: boolean }): { threadId: string; done: Promise<string> }; complete(profile, system, prompt): Promise<{ text: string; usage?: Usage }>; writeNote(company, path, content): Promise<void>; notify(title, body): void; emit(event: LiveEvent): void }
CompanyEngine: createTask, comment, move, remove, report, review, escalate, ask, createMeeting, say, end, cancel, startNow, overBudget(company, memberId): string | null, recordUsage, snapshot, tick, pump
canReportTo(company, memberId, boss: string | null): boolean;  costOf(provider, usage): number
```
Agent tools (all `standalone`): `assign_task` (`memory`), `update_task` (`memory`), `review_task` (`memory`), `list_tasks` (`read`), `ask_colleague` (`memory`), `escalate` (`memory`), `schedule_meeting` (`memory`). Task statuses `todo | in_progress | review | done | blocked`; `MAX_REVISIONS = 2`; `TICK_MS = 30_000`.
Requests: `company.snapshot`, `company.task.create|comment|review|move|delete`, `company.meeting.create|start|say|end|cancel`, `company.whatsapp.status|logout`. Events: `company.changed`, `company.whatsapp`. Desktop API: `settings.setCompanySecret(companyId, secret)`.

## 4. Data and persistence
Definitions live in settings (`companies`, `agents` with `companyId`, `routines`); mailbox passwords in `companySecrets`, sealed. Runtime state is `<userData>/companies/<companyId>.json`: tasks, meetings, activity (last 300), spend per month, and the budget warnings already sent; written to a `.tmp` file then renamed. On load, `in_progress` tasks return to `todo` and `live` / `preparing` meetings to `scheduled`; a corrupt file starts empty. Company threads are ordinary threads with channel `company`; minutes go to `Reuniones/<date> <topic>.md` in the company vault; a company's WhatsApp session is in `whatsapp-auth-<companyId>`.

## 5. Dependency injection
`CompanyEngine` receives `EngineDeps`; `tests/company.test.ts` fakes `runMember` (assignees deliver, bosses approve), `complete` (meeting turns and the minutes JSON), `writeNote`, `notify` and `emit`, and uses a real `CompanyStore` on a temp folder. Tools get the seat through `ToolContext.company` (`company`, `memberId`, `engine`, `noAsk`). The clock is passed to `tick(now)`.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-2.1 | `tests/company.test.ts` → `knows who is below, who can be asked, and refuses loops` | dotted line both ways, report to a subordinate |
| AC-2.2–2.4 | [gap] | cycle, dangling `reportsTo`, no head |
| AC-2.5–2.13 | [manual] open the Organigrama tab, drag positions in Configuración → Equipos, edit, remove and delete as written in each criterion | drop onto itself or a subordinate |
| AC-1.1, 1.2 | [manual] create each template, read the chart | name with `\ / : *` |
| AC-1.3, 1.4 | [gap] | names exhausted, cycling |
| AC-3.1 | `tests/company.test.ts` → `a boss assigns, the assignee delivers once, the boss reviews and approves` | one run per delivery |
| AC-3.2 | `tests/company.test.ts` → `the board's own tasks wait for the user's review` | send-back wakes the assignee, `revisions` is 1 |
| AC-3.3–3.11, 3.15 | [gap] | stranger as assignee, third send-back, reviewer outside the chain, comment by the assignee |
| AC-3.12–3.14 | [manual] drag cards, open the drawer, create a task | drag to `in_progress` |
| AC-4.1–4.11 | [gap] | agent outside a company, assign above, `ask_colleague` while answering, bad date |
| AC-7.1 | `tests/company.test.ts` → `a meeting prepares, talks by turns and leaves minutes and tasks` | transcript order, action owners |
| AC-7.2–7.12 | [gap] | invalid minutes JSON, note write failure, cancel a `done` meeting |
| AC-7.13, 7.14 | [manual] schedule and run a meeting from the Reuniones tab | no topic, no agenda |
| AC-8.1, 8.3 | `tests/company.test.ts` → `stops waking agents once the budget is spent` | company cap only |
| AC-8.2, 8.4–8.7 | [gap] | cache-read pricing, month rollover, 80 % jump to 100 % |
| AC-8.8 | [manual] set a low cap and read the badge | |
| AC-9.1–9.3, 9.6–9.8 | [gap] | boss flags, boss cannot review, reports to the board |
| AC-9.4, 9.5 | [manual] test mailbox and a spare WhatsApp number | |
| AC-10.1–10.3 | [gap] | corrupt file, more than 300 entries |
| AC-10.4–10.8 | [manual] open Empresas with and without companies | |

## 7. Security and privacy impact
`list_tasks` is `read`; the other six tools are `memory`, which never asks, so a company agent can create work, meetings and escalations unprompted. `write_file`, `edit_file`, `office_create`, `office_edit`, `generate_image` and `compose_image` run without asking inside a company's vault; every `publish` tool asks the direct boss first (an LLM review in the boss's voice), then the person, without "always allow". The mailbox password is sealed like API keys and never reaches the window; a company's mailbox and WhatsApp are separate accounts. No new third party. `docs/security/` entries for this belong to spec 022; none is edited here.

## 8. Rollout
No flag: the feature appears as the Empresas view and the Equipos tab. A new company starts with a USD 20 monthly cap, the company vault is created and added to the known vaults, and agents sleep until a task, meeting, routine or message wakes them. Budget 0 means no cap; warnings go out at 80 % and 100 %.
