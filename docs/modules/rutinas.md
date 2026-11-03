# Routines and reminders

> Scheduled things: a **reminder** only notifies you; a **routine** makes an agent do a task alone, in a new conversation. Spec: [018 · Rutinas y recordatorios](../../.specify/specs/018-routines-and-reminders/spec.md). Test status: 13 criteria with a test, 17 checked by hand, 24 without a test (of 54).

## What it does

You can schedule two kinds of things:

- **Reminder** ("recordatorio"): when it is due Alma shows a Windows notification, an alert inside Alma that stays on screen until you close it, and a Telegram message if Telegram is connected. No agent runs and no model tokens are used.
- **Routine** ("rutina"): when it is due an agent starts a new conversation in a folder and does the task you wrote, as if you had sent it as a message.

Both can run **once** at a date and time, **at a fixed time** on chosen weekdays (or every day), or **every N minutes or hours** (at least 5 minutes). You create them from the "Rutinas y recordatorios" dialog or by asking an agent in chat, voice, Telegram or WhatsApp. Alma keeps running in the system tray when you close the window, so schedules still fire. From the dialog you can see, test, pause, edit and delete everything, with its next and last run.

An agent can create reminders and routines, list them and delete them, and always knows the current local date and time.

## How to use it

**From the dialog.** Click **Rutinas** in the sidebar (it shows the count). The dialog lists every item with its name, a badge ("recordatorio" or "rutina", "ejecutándose" = running, "pausada" = paused), the schedule text, the agent and folder (for routines) or the message (for reminders), and "Próxima" (next) and "Última" (last, relative time or "nunca" = never). It refreshes every 30 seconds. When empty it says "Todavía no hay rutinas." (no routines yet).

- **+ Recordatorio** opens the editor with a new one-off reminder for tomorrow at 09:00. **+ Rutina con agente** opens a daily 09:00 routine with the default agent and default folder. Nothing is saved until **Guardar**.
- Schedule kinds in the editor: "Una vez" (once), "A una hora fija" (fixed time, with weekday buttons L M X J V S D; none selected = every day) and "Cada cierto tiempo" (every N hours or minutes). Save is disabled while the message is empty, a routine has no name, a fixed time is not `HH:MM`, an interval is under 5 minutes or a date is invalid. A past date warns "Esa fecha ya pasó: va a sonar apenas guardes." (that date has passed: it will go off as soon as you save).
- On a row: the "Activa" (active) toggle saves at once; **Editar**; **Borrar** asks "¿Borrar la rutina «…»?" and deletes only on confirmation; **Probar aviso** (test the alert, for reminders) delivers the notification without using the reminder up; **Ejecutar ahora** (run now, for routines) runs it immediately, opens the new conversation and closes the dialog; **Ver última ejecución** (see last run) opens the last conversation.
- **Plantilla: post diario de Instagram** opens an unsaved routine named "Post diario de Instagram", with agent `community-manager` if it exists (otherwise the default agent), Monday to Friday at 10:00, and a prompt that asks for today's post following `marca.md`, avoiding topics in `publicaciones.md`, generating the image, writing the text, publishing it and logging it. Publishing always asks your approval, so nothing is posted unattended ([Instagram](instagram.md)).

**By chat.** Ask any agent in natural language:

- "Haceme acordar mañana a las 10 que llame al dentista" ("remind me tomorrow at 10 to call the dentist") → `create_reminder`.
- "Todos los lunes a las 9 resumí las novedades de mi carpeta" ("every Monday at 9 summarize the news in my folder") → `create_routine`; you see an approval card first.
- "¿Qué rutinas tengo?" ("what routines do I have?") → `list_routines`.
- "Borrá el recordatorio del dentista" ("delete the dentist reminder") → `delete_routine`.

**Background settings.** In **Configuración → General**, section "Segundo plano" (Settings → General → Background): "Al cerrar la ventana, seguir en la bandeja del sistema" (on by default) and "Abrir al iniciar Windows (minimizada)" (off by default). The tray menu has "Abrir Alma" and "Salir"; choosing "Salir" quits everything and nothing fires until you open Alma again.

## How it works

| Piece | File | Role |
|---|---|---|
| Due-time logic (pure) | `shared/schedule.ts` | is it due, when is the next run, text description of a schedule |
| Runner | `coordinator/routines.ts` | the clock, run state, launching |
| Launch and delivery | `coordinator/index.ts` | creates the conversation for a routine, sends reminders, wires the tools |
| Tools | `coordinator/tools/routines.ts` | the four agent tools |
| Notifications, tray, login item, single instance | `main/index.ts` | desktop side |
| UI | `renderer/src/components/RoutinesDialog.tsx`, alert stack in `App.tsx`, "Segundo plano" in `SettingsDialog.tsx` | |
| Date and time for the model | `coordinator/agent.ts` | adds "Fecha y hora local: …" to the system prompt |

```
 clock (5 s after start, then every 30 s) --> routines.ts: for each enabled, not running, due routine
        |                                          |
        |                       reminder  ---------+--> notify (title "Recordatorio") + Telegram "⏰ <message>"
        |                       task      ---------+--> new thread "Rutina · <name> · dd/mm hh:mm" --> agent run
        v
 routines-state.json (lastRunAt, lastThreadId, running)
```

Messages: requests `routines.state`, `routines.runNow`; event `routines.state`; coordinator → main `notify` (`title`, `body`, `threadId?`, `always?`) and `settings.patch`; main → renderer `app:reminder`, `app:openThread`, `settings:changed`. See [IPC reference](../references/mensajes-ipc.md).

**Due times** (`shared/schedule.ts`):

- **Daily** (fixed time): due when today is an allowed day, now is at or past the slot, and the last run (or creation) was before the slot. A missed slot of today is caught up if you open Alma later the same day; a missed slot of an earlier day is not.
- **Interval**: due when the full interval has passed since the last run, or since creation if it never ran. The first run is one interval after creation.
- **Once**: due when now is at or past `at` and it never ran or last ran before `at`. A missed one fires late on the first tick after start. Moving its date later re-arms it.
- A disabled routine is never due and shows no next run, but can still be run by hand.
- An unreadable fixed time falls back to hour 9, minute 0.

**Not obvious:**

- Run state (`lastRunAt`, `lastThreadId`, `running`) is separate from settings, in `routines-state.json`. At load every `running` flag is cleared, because a run cannot survive a restart. When a run is launched `lastRunAt` is set to now at once and saved, so a failure does not retrigger it.
- A routine never overlaps itself; "Ejecutar ahora" on a running one fails with "La rutina ya se está ejecutando."
- "Ejecutar ahora" counts as a run (it sets `lastRunAt`), so an interval routine's countdown restarts and a fixed-time routine does not fire again that day if its time already passed. "Probar aviso" on a reminder does not change state.
- A routine's own tool calls follow the normal approval policy: nothing is pre-approved, so a run can sit waiting for you.
- The list of routines is part of settings; the agent tools change it through a `settings.patch` message to main, which persists it and makes the dialog refresh. A tool call in the same turn already sees the new list.
- Windows toasts can be dropped silently (Focus Assist, app identity), which is why there is also an in-app alert that stays.

## Tools for agents

Available to every agent in every conversation (including voice, Telegram and WhatsApp), none needs a working folder. Source: `coordinator/tools/routines.ts`. See [tools reference](../references/herramientas.md).

| Name | Risk | Asks approval | Purpose |
|---|---|---|---|
| `create_reminder` | `memory` | no | Save a reminder (notify only). Message of at least 2 characters. A long message is named with its first 57 characters plus "…". |
| `create_routine` | `write` | yes in modes that ask for writes | Save a task for an agent (the caller by default) in a folder (the conversation's folder by default). Name at least 3, task at least 10 characters; the task must stand alone because the routine's agent does not see the creating conversation. |
| `list_routines` | `read` | no | List reminders and routines; paused ones are marked "pausada". With none: "No hay recordatorios ni rutinas." |
| `delete_routine` | `memory` | no | Delete by id; unknown ids fail with "No existe la rutina <id>. Usá list_routines para ver los ids." |

Schedules in the tools: `once.at` is a local `AAAA-MM-DDTHH:MM` and must not be more than 60 s in the past ("Esa fecha ya pasó (…)"); `daily.time` matches `\d{2}:\d{2}` with weekdays 0 to 6 (0 = Sunday); `interval.minutes` is an integer of at least 5. An unknown agent fails with "No existe el agente …". Ids look like `rutina-` plus 6 base-36 characters.

## Settings and data

| What | Default | Where |
|---|---|---|
| Routine and reminder definitions | empty list | `settings.json` → `routines` |
| Run state | empty | `routines-state.json` in the data folder (written through a temporary file and a rename; entries for deleted routines are never removed) |
| Stay in the tray when the window closes | on (`background.runInTray`) | `settings.json` → `background` |
| Open at Windows start, hidden | off (`background.launchAtLogin`); login start passes `--hidden` | `settings.json` → `background` |

Only one instance of Alma runs; opening it again shows the existing window. More in [settings reference](../references/ajustes.md) and [data reference](../references/datos.md).

## Limits and rules

| Rule | Value |
|---|---|
| Runner clock | first check 5 s after start, then every 30 s (granularity 30 s) |
| Minimum interval | 5 minutes (tools and editor) |
| Past dates | tools reject more than 60 s in the past; the editor allows them with a warning |
| Tool field minimums | reminder message 2, routine name 3, task 10 characters |
| Reminder name | message cut to 60 characters when saved from the editor |
| Weekdays | 0 (Sunday) to 6 (Saturday); empty list = every day |
| Dialog refresh | every 30 s |
| Routine conversation title | `Rutina · <name> · dd/mm hh:mm` |
| Completion/failure notices | only when the window is not focused; reminders always show, even focused |

Schedule text reads like `lun, mar, mié, jue, vie a las 10:00` or "todos los días a las HH:MM", `cada 3 h` or `cada 90 min`, and `una vez, el <short date>`. All times use the computer's local time zone and clock; if the computer sleeps or Alma is closed nothing fires and the missed-run rules above apply on return. Summary of numbers: [limits reference](../references/limites.md).

## Security and privacy

- `create_routine` asks for approval (risk `write`), because it sets up a task that later runs unattended. `create_reminder` and `delete_routine` do not ask, so an agent can silently delete a routine you made by hand or create reminders freely.
- A routine's own tools follow the normal approval policy. Publishing (for example the Instagram template) always asks, whatever the mode.
- A reminder's text is sent to Telegram when connected; a routine's results are not (only reminders are).
- A routine run sends its task and everything the agent reads to the agent's model provider, like any conversation.
- Changes to routines from the dialog do not go through the native confirmation that MCP changes use ([MCP](mcp.md)).
- See [security module](seguridad.md).

## How it is tested

- `tests/schedule.test.ts` covers the pure logic: once a day, same-day catch-up and not next day, no run on the creation day after the time, weekdays and the enabled flag, intervals from creation or last run, next allowed day and schedule description, one-offs firing late, and re-arming by moving the date.
- `tests/routines-tools.test.ts` covers the tools: a one-off reminder from local time (create, list, delete), rejecting past dates and unknown agents, and an agent routine in the conversation workspace that needs approval.
- Not covered: the runner and its saved state, delivery (notification, in-app alert, Telegram), the dialog, the tray and login item, the tool validation minimums.
- By hand: create a reminder one minute ahead, minimize Alma and wait; let two alerts stack and close one; click the toast; close the window and check the reminder still fires; turn off the tray option and close; start Alma twice; press "Ejecutar ahora" and "Ver última ejecución"; try an interval of 2 minutes.

## Known limits

Prioritized. Spec: [018](../../.specify/specs/018-routines-and-reminders/spec.md).

1. **An unattended routine can hang forever.** If the agent needs approval it waits with no timeout and the routine stays "ejecutándose".
2. **Agents can silently delete or spam.** `create_reminder` and `delete_routine` need no approval, and there is no tool to pause or edit, only delete and create.
3. **Bad times are accepted.** `daily.time` is only checked as `\d{2}:\d{2}`, so "25:99" rolls over to a later day, and a date-only `once.at` is read as midnight UTC, not local.
4. **"Ejecutar ahora" changes the schedule.** It records a run, so a fixed-time routine will not fire again that day and an interval timer restarts.
5. **Missed intervals are not caught up.** An interval routine's first run is one full interval after creation, and after a long closure it runs once, not once per missed interval.
6. **Routine results do not reach Telegram**; you must open the conversation from the desktop notification.
7. Tools and the editor disagree about past dates (60 s tolerance versus allowed with a warning).
8. State entries of deleted routines are never removed, and an in-app alert is lost if the page reloads before you dismiss it.

Rationale not documented: why `create_reminder` and `delete_routine` are `memory` rather than `write`. The README only states that `create_routine` asks.

## See also

- [Agents](agentes.md) · [Approvals](aprobaciones.md) · [Telegram](telegram.md) · [Instagram](instagram.md) · [Companies](empresas.md) (a position's weekday routine) · [Home](casa.md) (home rules are a separate mechanism) · [Settings](configuraciones.md) · [App shell](app-shell.md)
- References: [tools](../references/herramientas.md), [settings](../references/ajustes.md), [data](../references/datos.md), [limits](../references/limites.md).
