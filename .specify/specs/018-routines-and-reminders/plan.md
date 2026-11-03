# 018 — Plan

## 1. Approach
Scheduling decisions are pure functions in `src/shared/schedule.ts` (`isDue`, `nextRun`, `describeSchedule`) that take the clock as an
argument. A `RoutineRunner` in the coordinator polls them every 30 seconds, keeps run state (`lastRunAt`, `lastThreadId`, `running`)
in its own file, and hands due items to a `launch` callback: a reminder is delivered with no agent; a task starts a new thread
for its agent. Delivery is layered because Windows can drop toasts: an OS notification from main, a persistent alert in the
renderer, and Telegram when connected. Agents create schedules through four tools that patch `settings.routines`; the tray option
keeps the process alive so the poller keeps running.

Rejected: OS-level scheduling (Windows Task Scheduler) or one timer per routine. It would need a second launch path with no
coordinator, a different approval story for unattended runs, and timers that drift or vanish across sleep; polling the pure
`isDue` is trivially testable and gives the same catch-up rules after any pause.

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | `src/shared/schedule.ts`, `src/shared/types.ts` (`Routine`, `RoutineSchedule`, `RoutineState`), `src/shared/defaults.ts`, `src/shared/desktop-api.ts` | Due-time rules are pure and used by the runner and the dialog; types cross processes |
| coordinator | `src/coordinator/routines.ts`, `src/coordinator/tools/routines.ts`, `src/coordinator/index.ts`, `src/coordinator/agent.ts` | Runner, delivery, thread creation, the agent tools and the date in the system prompt |
| main | `src/main/index.ts`, `src/preload/index.ts` | Notifications, tray, login item, single instance, applying `settings.patch` from the coordinator |
| renderer | `src/renderer/src/components/RoutinesDialog.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/components/SettingsDialog.tsx` ("Segundo plano"), `src/renderer/src/lib/state.ts` | Dialog and editor, alert stack, background options |

## 3. Contracts
- `RoutineSchedule` = `{ kind: 'once'; at } | { kind: 'daily'; time; days } | { kind: 'interval'; minutes }`.
  `Routine` = `{ id; name; agentId; workspace; prompt; schedule; enabled; createdAt; action?: 'task' | 'reminder' }`.
  `RoutineState` = `{ lastRunAt?; lastThreadId?; running? }`. `Settings.routines: Routine[]`, `Settings.background`.
- `isDue(routine, lastRunAt, now): boolean`, `nextRun(routine, lastRunAt, now): Date | undefined`, `describeSchedule(routine): string`.
- `class RoutineRunner(dataDir, getRoutines, launch, onChange)`: `start()`, `stop()`, `snapshot()`, `tick(now?)`, `run(routine)`.
- Requests `routines.state` and `routines.runNow { routineId }`; event `routines.state`. Coordinator → main `notify
  { title, body, threadId?, always? }` and `settings.patch`; main → renderer `app:reminder` (`window.desktop.onReminder`),
  `app:openThread`, `settings:changed`.
- Tools (all `standalone`): `create_reminder` (`memory`), `create_routine` (`write`), `list_routines` (`read`), `delete_routine`
  (`memory`). `ToolContext.saveRoutines(routines)` persists through `patchSettings`. `parseLocalDateTime(text): number`.

## 4. Data and persistence
Definitions live in `settings.json` under `routines` (edited from the dialog through `settings:update`, from agents through
`settings.patch`). Run state lives in `<userData>/routines-state.json`, written to a temporary file and renamed, kept apart from
settings so a run never rewrites configuration. A missing or corrupt file means empty state; every `running` flag is cleared at
load. Routines saved before reminders existed have no `action` and count as tasks.

## 5. Dependency injection
`isDue`/`nextRun` take `now`; `RoutineRunner` takes the routine getter and the `launch` callback instead of importing the
coordinator; tools receive `ToolContext` (`settings`, `agentId`, `workspace`, `saveRoutines`). Tests fake the context with
`defaultSettings()` and a recording `saveRoutines`. The runner, delivery, tray and dialog have no fakes yet.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1 | `tests/schedule.test.ts` → `runs once the time has passed, and only once a day` | second tick the same day |
| AC-1.2 | `tests/schedule.test.ts` → `catches up a missed run later the same day but not the next day` | open the next day |
| AC-1.3 | `tests/schedule.test.ts` → `does not run on the day it was created after the time` | |
| AC-1.4 | `tests/schedule.test.ts` → `respects the chosen weekdays and the enabled flag` | empty day list, disabled |
| AC-1.5 | `tests/schedule.test.ts` → `waits the full interval from creation or the last run` | never ran |
| AC-1.6 | `tests/schedule.test.ts` → `fires once at its time, and late if the app was closed then` | already fired |
| AC-1.7 | `tests/schedule.test.ts` → `fires again after being moved to a later date` | |
| AC-1.8, 1.9 | `tests/schedule.test.ts` → `finds the next allowed day` | 7-day search, whole-hour interval |
| AC-5.1 | `tests/routines-tools.test.ts` → `creates a one-off reminder from local time, lists it and deletes it` | |
| AC-5.2, 5.3 | `tests/routines-tools.test.ts` → `rejects dates in the past and unknown agents` | |
| AC-5.4 | `tests/routines-tools.test.ts` → `creates an agent routine in the conversation workspace that needs approval` | |
| AC-1.10, 2.1–2.7, 3.3–3.5, 4.1–4.3, 4.5, 5.5–5.12, 6.8 | [gap] | restart mid-run, corrupt state file, overlap, "25:99" |
| AC-3.1, 3.2, 3.6, 4.4, 6.1–6.7, 6.9, 7.1–7.5 | [manual] — reminder one minute ahead with the window minimized; open the dialog; toggle the tray option | |

## 7. Security and privacy impact
- `create_routine` is `write`: it asks wherever writes ask, since it schedules unattended agent work. `create_reminder` and
  `delete_routine` are `memory` (no approval); `list_routines` is `read`.
- A routine run has no pre-approved tools: its tool calls follow the normal approval policy and wait for the person.
- A reminder's text goes to Telegram when connected; no other third party. Notification text carries the reminder message only.
- No change to `docs/security/` files: no new secret, permission or external service.

## 8. Rollout
No flag. `routines` defaults to `[]`; `background.runInTray` defaults to on and `launchAtLogin` to off (login start passes
`--hidden`). First run: the sidebar shows the Routines button and the dialog says "Todavía no hay rutinas."; agents can create
schedules from any conversation. Turning the tray option off makes closing the window quit Alma and stops all schedules.
