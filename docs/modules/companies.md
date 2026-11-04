# Companies

> Teams of agents that run a business: org chart, task board, meetings, budgets and accounts of their own. Spec: [007 · Empresas](../../.specify/specs/007-companies/spec.md). Test status: 6 criteria with a test, 24 checked by hand, 51 without a test (of 81).

## What it does

A **company** (Spanish UI: "empresa") is a team of agents that works for you. It has its own vault folder, an org chart (every position is an agent), a task board, meetings, a monthly budget and, optionally, its own mailbox and its own WhatsApp number. You are the **Directorio** (the board), the root of the chart: you approve and decide.

The key point: agents are **not alive all day**. They sleep and wake only for something concrete: a task assigned or commented, a review, a meeting, a routine of their position, or a message from you. That keeps model cost down.

What the person can do:

- Create a company from a template («Agencia de marketing», «Ecommerce / tienda», «Administración / estudio») or blank.
- Edit the org chart (add, remove and move positions, dotted lines) and the agent of each position.
- Give a task to any member, review what they deliver (approve or ask for changes) and comment.
- Call meetings: members prepare, speak in turns and leave minutes and tasks.
- Set a monthly cap in dollars for the company and for each member.
- Watch what the team does (activity, who is working, spend) and talk to any member.

What agents can do, with seven tools: assign tasks to their team, deliver or block a task, review what someone on their team delivered, ask a colleague, escalate to the boss or the Directorio, and schedule meetings.

## How to use it

**Create a company.** Open «Configuración → Equipos» (Settings → Teams). Pick a template, a name (empty = the template's name, or "Mi empresa" for blank) and a vault folder. The default folder is `<parent of the default vault>\Empresas\<name>`; "Elegir carpeta" (choose folder) overrides it. Press **Crear empresa**. One agent per template position is created, the company starts with a USD 20 monthly budget and it becomes the selected one.

**Edit the team** (same screen):

- Name, colour (8 swatches), mission, goals (one per line), vault and monthly budget (0 = no cap). Every keystroke is saved at once.
- Drag a position onto another to change who it reports to; onto the Directorio card to make it report to you. A drop that would make a loop (onto itself or onto a subordinate) is ignored.
- **Agregar puesto** (add position) creates "Nuevo puesto" under the selected one (or under the head) with an agent that only has file tools and cannot delegate.
- The position editor changes the agent's name, title, description (colleagues read it), instructions, boss, personal budget, dotted-line collaborators, provider, model, effort and tools. You can also add a weekday routine (default 09:00, «Revisá tus tareas pendientes y avanzá con la más importante.» = "Review your pending tasks and move the most important one forward").
- **Sacar puesto** (remove position, with confirmation): its reports move to its boss. **Borrar empresa** (delete company) removes company, agents and routines but not the vault files.
- **Accounts**: its own mail address (IMAP/SMTP servers are guessed from the address), password (stored encrypted; the window only sees "Guardada") and a WhatsApp switch with its QR and a "Desvincular" (unlink) button.

**Work in the Empresas view** (sidebar → a company). The header shows colour, name, mission, month spend (`USD x.xx / cap`, highlighted from 80 %), **Hablar con <head>** (talk to the head) and **Vault**. There are five tabs:

| Tab | What it is for |
|---|---|
| «Tablero» (board) | Five columns: «Por hacer» (to do), «En curso» (in progress), «En revisión» (in review), «Trabadas» (blocked), «Hechas» (done). «Nueva tarea» takes title, detail and assignee (default: the head). An open task offers «Aprobar» / «Pedir cambios» (approve / ask for changes) when in review, «Comentar», «Ver cómo la hizo» (see how it was done) and «Borrar». |
| Chats | Only conversations of the company's members. |
| Reuniones (meetings) | «Convocar reunión»: topic, agenda (one point per line), when (default now + 3 h), prep hours (0 to 48, default 2), chair and participants. Buttons: Empezar ahora, Cancelar, Terminar, Ver acta. The box "Intervenir como Directorio…" lets you speak into a live meeting. |
| Organigrama (org chart) | The tree of cards; a glowing card is working; each shows the month's spend; a click opens a new conversation with that agent. |
| Actividad (activity) | The latest events, newest first. |

One board detail: dragging a card to another column changes its status with no validation (and wakes the assignee when you drop it in «Por hacer»). It is handy, but it skips the review rules.

**Ask Alma in chat.** You run the company from the view; in chat you can talk to the head ("Hablar con…") and ask for work in natural language, for example «armá el plan de contenidos de noviembre y repartilo con el equipo» ("build the November content plan and split it among the team"). The company tools are visible only to agents that belong to a company, not to your personal agents.

## How it works

Pieces, all under `src/`:

| Piece | File | What it does |
|---|---|---|
| Pure rules | `shared/company.ts` | org chart (`canReportTo`, subordinates, colleagues, chain of command), templates, prices (`PRICES`), cost of a usage, month key |
| Engine | `coordinator/company/engine.ts` | tasks, meetings, budgets, notifications, the clock |
| Persistence | `coordinator/company/store.ts` | reads and writes `companies/<id>.json` |
| Tools | `coordinator/tools/company.ts` | the seven agent tools |
| Wiring | `coordinator/index.ts`, `agent.ts`, `approval.ts` | engine start, company-agent context, boss review |
| Secrets | `main/settings.ts`, handler `settings:setCompanySecret` in `main/index.ts` | encrypted mailbox password |
| UI | `renderer/src/companies/` (`CompaniesView`, `OrgChart`, `TeamsSettings`) | Empresas view and Equipos tab |

```
 person --(window)--> company.task.* / company.meeting.*  --+
                                                             v
 clock (every 30 s, first at 8 s) ------------------------> engine --> startRun(company agent)
                                                             |            | tools assign_task, update_task...
                                                             v            v
                                           companies/<id>.json      company vault
                             company.changed --> the window reloads its snapshot
```

**Task flow.** A boss assigns (`assign_task`) → the engine wakes the assignee with a run titled «Tarea · <title>» (one run per member at a time) → the assignee delivers with `update_task(review)` → the creator reviews. If the creator is a member, they wake with «Revisión · <title>» and call `review_task`; approving ends the task `done` with the delivered text as `result`. If the creator is you (the Directorio), the task waits in `review` and you get the notification "<company>: entrega para revisar" (delivery to review). Asking for changes sends it back to `todo`; on the third send-back (`MAX_REVISIONS = 2`) it becomes `blocked` and goes to the Directorio.

**If the assignee does not deliver with the tool**, the run's final answer is taken as the delivery. If the run fails, the task becomes `blocked` with the comment «Falló: …» (failed). If the assignee reports `blocked`, the boss gets a task "Consulta de <name>" (query from).

**Meetings.** `scheduled` → at `time − prep hours` each participant prepares once («Preparación · <topic>») → at the time it goes live. Turns are a single model call with no tools, low effort, at most 120 words. The turn cap is `min(60, items × (others + 1) + 6)`. The chair opens; for each agenda item every other participant speaks once and the chair closes it. At the end the chair writes the minutes (JSON), the note `Reuniones/<date> <topic>.md` is written into the company vault, and agreed actions become tasks created by the chair.

**Costs and caps.** Each model usage is estimated at the provider's list price (one price per provider, not per model) and added to the company's and the member's month. The check (`overBudget`) runs when a run, review, preparation or turn **starts**; a run already going is not cut (see Known limits).

**Restart.** On startup `in_progress` tasks go back to `todo` and `live`/`preparing` meetings go back to `scheduled`. The file is written to a `.tmp` and renamed; if missing or corrupt, the company starts empty.

**Not obvious:**

- Company agents are ordinary profiles with a `companyId`. They are hidden from the agent lists and the general chat; their conversations live only under Empresas → Chats.
- Their working folder and knowledge **are the company vault** (with its own `Alma/Recuerdos.md`), never your active vault. They never get the house tools or `delegate_task`, and your personal agents never delegate to them.
- `memberAgent` creates every new agent with provider `anthropic`, the default Claude model, effort `medium`, MCP off.
- Templates build a "Director/a general" at the top, who can delegate and whose instructions say to assign work, review, and ask the Directorio with `escalate` before big plans or spending. Agent names come from a fixed list of 16 first names.

## Tools for agents

Offered only to agents that belong to a company; elsewhere they fail with «Esta herramienta es solo para agentes de una empresa.» (this tool is only for company agents). All work without a working folder. Source: `coordinator/tools/company.ts`. Full list in [tools reference](../references/tools.md).

| Name | Risk | Asks approval | Purpose |
|---|---|---|---|
| `assign_task` | `memory` | no | Assign a task to someone on its team (any depth below). |
| `update_task` | `memory` | no | Deliver (`review`/`done`) or block (`blocked`) its own task; `result` of at least 3 characters. |
| `review_task` | `memory` | no | Approve or send back a delivery (only the requester or a boss of the assignee). |
| `list_tasks` | `read` | no | List tasks: `mine` (default), `team` or `company`; `include_done` off by default. |
| `ask_colleague` | `memory` | no | Ask its boss, team or dotted-line colleague and get the answer immediately. |
| `escalate` | `memory` | no | Pass a problem to its boss (creates a task «Consulta de …») or, if it reports to the board, notify you. Message of at least 10 characters. |
| `schedule_meeting` | `memory` | no | Call a meeting (1 to 8 agenda items, local time `AAAA-MM-DDTHH:MM`, `prep_hours` default 2, range 0 to 48). |

Because `memory` and `read` never ask in any approval mode, a company agent can create work, meetings and escalations without asking you.

## Settings and data

| What | Default | Where |
|---|---|---|
| List of companies | empty | `settings.json` → `companies` |
| Company agents and their routines | — | `settings.json` → `agents` (with `companyId`) and `routines` |
| Monthly budget of a new company | USD 20 (0 = no cap) | company `budgetUsd` |
| Budget of a member | 0 (only the company's cap applies) | member `budgetUsd` |
| Company mailbox password | — | `settings.json` → `companySecrets`, encrypted with `safeStorage`; never sent to the window |
| Board, meetings, activity (300), spend per month, budget warnings already sent | — | `<dataDir>/companies/<id>.json` (JSON, indent 1, written through `.tmp` then renamed) |
| Company WhatsApp session | — | `<dataDir>/whatsapp-auth-<id>` |
| Documents and minutes | — | the company's vault folder |
| Conversations | — | ordinary threads with channel `company` |

Full data map: [data reference](../references/data.md). Settings: [settings reference](../references/settings.md).

## Limits and rules

| Rule | Value |
|---|---|
| Send-backs allowed per task | 2; the third blocks it and notifies (`MAX_REVISIONS = 2`) |
| Engine clock | every 30 s, first check at 8 s |
| Retry of a review when the creator is busy | every 15 s, no limit |
| Meeting turn | 1 call, no tools, effort `low`, 120 words |
| Meeting turn cap | `min(60, items × (others + 1) + 6)` |
| Preparation | `prepHours` before the time (default 2, 0 to 48) |
| Activity kept / sent to the window | 300 / 150 entries |
| Budget warnings | at 80 % and 100 %, once per month per cap |
| Agents working | one per member at a time |
| Tools that do not ask inside a company | `write_file`, `edit_file`, `office_create`, `office_edit`, `generate_image`, `compose_image` (plus the position's `autoApproveTools`) |

Prices used (USD per million tokens, input / output / cache read; `shared/company.ts`): anthropic 5 / 25 / 0.5 · xai 3 / 15 / 0.75 · deepseek 0.3 / 1.2 / 0.03 · vercel 3 / 15 / 0.3 · meta 1.25 / 4.25 / 0.15. Spend is an **estimate**, not the bill. The month rolls over by local time (`YYYY-MM`) and the new month starts at zero. (More in [limits reference](../references/limits.md).)

Who can direct whom: `assign_task` only to subordinates (any depth); `ask_colleague` to boss, team (any depth) and dotted line; `schedule_meeting` to boss, team and colleagues. A dotted line works both ways. A position cannot report to itself or to someone below it.

Alerts you receive (desktop and Telegram): delivery to review, task that will not move, blocked member with no boss, meeting starting, budget at 80 % and 100 %.

## Security and privacy

- **Anything that leaves the company passes two filters.** A tool of risk `publish` (mail, posts, WhatsApp) is first reviewed by the agent's direct boss (a model, with the boss's instructions). If flagged, it is rejected («Rechazado por <boss>: …»). If approved, you decide («Aprobado por <boss>: …», no "always allow"). If the agent reports to the Directorio there is no boss step and you are asked directly. The policy lives in `coordinator/approval.ts` ([approvals module](approvals.md)).
- **Writing in the company vault does not ask** (it is the normal work). Commands and other tools follow the approval mode; read-only mode still blocks everything.
- **Separate accounts**: the company mailbox and WhatsApp are apart from yours. With an empty mail address, agents use yours. The password is encrypted and does not return to the window.
- **What leaves your machine**: what any agent sends to its model provider (tasks, company context, vault fragments) and what gets published after your approval. No new third party.
- Security notes: [security module](security.md) and `docs/security/`.

## How it is tested

- `tests/company.test.ts` covers five behaviors: org chart and loops, a boss that assigns and reviews, board tasks that wait for your review, the budget cap that stops waking agents, and a full meeting (preparation, turns, minutes and tasks).
- **No test**: the seven tools and their error messages, meeting limits, budget warnings, persistence and restart, and most task logic (comments that reopen, blocked, escalation).
- **By hand**: everything on screen. Create each template and read the org chart; drag positions and cards; set a low cap and watch the badge; call a scheduled and a live meeting; link a spare WhatsApp and a test mailbox.

## Known limits

Ordered by how likely they are to bite. Spec: [007](../../.specify/specs/007-companies/spec.md).

1. **The budget cap is soft.** It is checked only at start; a run already going keeps spending after crossing the cap.
2. **An escalation is reviewed backwards.** What a subordinate escalates creates a task whose creator is the subordinate and assignee the boss; on delivery the subordinate reviews it.
3. **Reviews that get lost.** If the creator never calls `review_task` or the review run fails, the task stays in `review` forever with no retry or alert; if the creator is busy it retries every 15 s without limit.
4. **Meetings after a restart.** A live meeting returns to "scheduled" with its old transcript and can append a second discussion; ending a meeting that is not live leaves a flag that cuts it short when it starts.
5. **Dragging on the board skips the rules.** Moving to "En curso" makes nobody work and stays until restart; moving to "Hecho" or «En revisión» ignores review.
6. **Deleting a company leaves leftovers**: `companies/<id>.json`, the WhatsApp auth folder and the linked session.
7. **New agents without an Anthropic key cannot run.** Every position is born with provider `anthropic`; without that key you must edit them one by one.
8. **One price per provider, not per model**, so Vercel AI Gateway or cheap-model spend is an approximation for a "hard" cap.
9. **The 80 % warning can arrive after the 100 % one** when a single usage jumps both thresholds.
10. **Every keystroke in the editor saves**, a change of boss or budget applies without confirmation, and deleting a running task leaves no trace (the agent then fails with «No existe la tarea»).
11. Budget and meeting alerts also go to Telegram even if you did not ask for them.

Rationale not documented: why a subordinate's `done` still goes through review unless that subordinate created the task (the code treats it as a review rule).

## See also

- [Agents](agents.md) · [Approvals](approvals.md) · [Routines](routines.md) (a position's routines) · [Vault and knowledge](vault-and-knowledge.md) (each company's vault) · [WhatsApp](whatsapp.md) · [Web and mail](web-and-mail.md) · [Office and drawings](office-and-drawings.md) · [Security](security.md)
- References: [tools](../references/tools.md), [data](../references/data.md), [limits](../references/limits.md).
- Design note: the feature was built as the last MVP piece after looking at Paperclip, CrewAI, MetaGPT, ChatDev and AutoGen. Owner decisions: agents work very little on their own and wake only for a concrete trigger (cost); each company has its own vault and accounts; outgoing actions go through the boss and then the person; budgets warn at 80 % and pause at 100 %.
