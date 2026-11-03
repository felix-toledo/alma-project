---
status: implemented
---

# 018 — Rutinas y recordatorios

## 1. Summary
A person can schedule two kinds of things. A **reminder** only notifies them (a Windows notification, an alert inside Alma that
stays until dismissed, and a Telegram message if Telegram is connected); it runs no agent. A **routine** makes an agent do a task
alone, in a new conversation, at the scheduled time. Both can happen once, at a fixed time on chosen weekdays, or every N
minutes/hours. They are created from the "Rutinas y recordatorios" dialog or by asking any agent in chat, voice, Telegram or
WhatsApp ("haceme acordar…"). Alma keeps running in the system tray when its window is closed so they still fire.

## 2. Problem and goal
Agents only act when spoken to, and people forget things. Done means: the person can say "recordame mañana a las 10 que llame al
dentista" or "todos los lunes a las 9 resumí las novedades de mi carpeta" and trust that it happens, even if the window is closed,
and can see, test, pause and delete everything that is scheduled.

## 3. Scope
**In:** the schedule kinds and how due times are computed, behavior on restart and on missed runs, the runner and its saved state,
reminder delivery, the routine's new conversation and its notifications, the tray/background settings as they relate to routines,
the Routines dialog and its templates, the four agent tools, the date/time context given to agents.

**Out (and why):**
- What the agent does inside a routine (tools, providers, loop): `../003-agents/spec.md`; approvals it may wait for: `../004-approvals/spec.md`.
- The Instagram flow the daily-post template triggers (brand file, publishing, the browser session): `../012-instagram/spec.md`.
- Telegram connection and chat binding: `../010-telegram/spec.md`.
- Home-automation rules (they also fire notifications but are their own mechanism): `../014-house-plan-cameras-and-rules/spec.md`.
- The rest of the app shell, tray menu and window handling: `../023-app-shell-and-ui/spec.md`.
- Where settings live: `../006-settings/spec.md`.

## 4. Users and stories
- **US-1** As a person using Alma, I want to be reminded of something at a time I choose, so that I do not forget it.
- **US-2** As a person using Alma, I want a reminder to reach me even if Alma is minimized or I am away from the PC, so that I see it.
- **US-3** As a person using Alma, I want an agent to do a recurring task on its own, so that I do not have to ask each time.
- **US-4** As a person using Alma, I want to schedule things by chatting ("haceme acordar…"), so that I need no form.
- **US-5** As a person using Alma, I want to see, test, pause, edit and delete what is scheduled, with its next and last run, so that I stay in control.
- **US-6** As a person using Alma, I want missed runs handled sensibly when Alma was closed, so that I neither lose a reminder nor get a flood.
- **US-7** As a person using Alma, I want Alma to keep running in the tray, so that schedules keep firing with the window closed.
- **US-8** As a person using Alma, I want a ready-made template for a daily Instagram post, so that I can set it up quickly.
- **US-9** As an agent, I want to know the current local date and time and to have tools to create, list and delete schedules, so that I can compute correct times.

## 5. Acceptance criteria

### Due times (US-1, US-3, US-6)
- **AC-1.1** (US-6) Given a fixed-time ("daily") routine, when the clock reaches its time, then it is due once, and not again that day after it ran; the next day after the time it is due again. Test: tests/schedule.test.ts › "runs once the time has passed, and only once a day"
- **AC-1.2** (US-6) Given a fixed-time routine missed because Alma was closed, when Alma opens later the same day, then it is due once; when it opens on a later day it is not due until the next scheduled time (earlier days are not caught up). Test: tests/schedule.test.ts › "catches up a missed run later the same day but not the next day"
- **AC-1.3** (US-1) Given a fixed-time routine created after that day's time, when evaluated that day, then it is not due until the next day's time. Test: tests/schedule.test.ts › "does not run on the day it was created after the time"
- **AC-1.4** (US-3) Given a fixed-time routine restricted to weekdays (0 = domingo … 6 = sábado), when evaluated on a day not in the list, then it is not due; an empty list means every day; a disabled routine is never due. Test: tests/schedule.test.ts › "respects the chosen weekdays and the enabled flag"
- **AC-1.5** (US-3) Given an interval routine, when evaluated, then it is due once the full interval has passed since its last run, or since its creation if it never ran. Test: tests/schedule.test.ts › "waits the full interval from creation or the last run"
- **AC-1.6** (US-6) Given a one-off whose moment has not come, when evaluated, then it is not due; once past, it is due even if Alma was closed at that moment (it fires late); after it has fired it is never due again and has no next run. Test: tests/schedule.test.ts › "fires once at its time, and late if the app was closed then"
- **AC-1.7** (US-5) Given a one-off that already fired, when its date is moved to a later moment, then it is due again at that new moment. Test: tests/schedule.test.ts › "fires again after being moved to a later date"
- **AC-1.8** (US-5) Given a routine, when its next run is computed for display, then fixed-time routines show the next allowed day and time (searching up to 7 days ahead), interval routines show the later of now and last run + interval, one-offs show their date or nothing once fired, and a disabled routine shows nothing. Test: tests/schedule.test.ts › "finds the next allowed day"
- **AC-1.9** (US-5) Given a schedule, when described, then it reads `lun, mar, mié, jue, vie a las 10:00` (or `todos los días a las HH:MM` when no days or all seven), `cada 3 h` when the minutes are a whole number of hours, otherwise `cada 90 min`, and `una vez, el <fecha corta>`. Test: tests/schedule.test.ts › "finds the next allowed day"; tests/schedule.test.ts › "fires again after being moved to a later date"
- **AC-1.10** (US-6) Given a fixed time that cannot be read as HH:MM, when evaluated, then the missing hour defaults to 9 and the missing minute to 0. [gap]

### The runner, restart and state (US-2, US-6)
- **AC-2.1** (US-3) Given the coordinator started, when 5 seconds have passed and then every 30 seconds, then every enabled routine that is due and not already running is launched. [gap]
- **AC-2.2** (US-6) Given Alma restarts, when the runner loads, then each routine's last-run time and last conversation are restored from `routines-state.json`, and every `running` flag is cleared (a run cannot survive a restart). [gap]
- **AC-2.3** (US-6) Given `routines-state.json` is missing or corrupt, when the runner loads, then it starts with empty state (no error). [gap]
- **AC-2.4** (US-3) Given a routine is launched, when it starts, then its last-run time is set to now immediately and the state is saved; when the run ends (success or failure) it is marked not running. [gap]
- **AC-2.5** (US-3) Given a routine still running when its next slot arrives, when the tick runs, then it is not launched again; "Ejecutar ahora" on a running routine fails with "La rutina ya se está ejecutando." [gap]
- **AC-2.6** (US-6) Given several routines due at the same tick, when the tick runs, then all are launched at once. [gap]
- **AC-2.7** (US-5) Given the run state changes, when it is saved, then the renderer receives the new state for all routines. [gap]

### Reminders (US-1, US-2)
- **AC-3.1** (US-2) Given a reminder fires, when it is delivered, then main shows a Windows notification titled "Recordatorio" with the message (shown even when the window is focused), the renderer receives it, and the taskbar flashes if the window is not focused. [manual] Check: create a reminder one minute ahead, minimize Alma, and wait.
- **AC-3.2** (US-2) Given the renderer receives a reminder, when it arrives, then a notification sound plays and an alert with the title and message appears inside Alma and stays on screen until the person closes it with its X; several alerts stack. [manual] Check: let two reminders fire and leave them; close one.
- **AC-3.3** (US-2) Given Telegram is connected to a chat, when a reminder fires, then the chat gets `⏰ <message>`; without a bound chat nothing is sent and nothing fails; a Telegram error is only logged. [gap]
- **AC-3.4** (US-1) Given a reminder, when it fires, then no agent runs, no conversation is created and no model tokens are used; its last run is still recorded. [gap]
- **AC-3.5** (US-5) Given a reminder in the dialog, when "Probar aviso" is pressed, then the alert/notification/Telegram message is delivered but the reminder's last-run state is not changed (a one-off is not used up). [gap]
- **AC-3.6** (US-1) Given the Windows notification is clicked, when it was raised for a reminder, then Alma's window is shown. [manual] Check: click the toast.

### Routines (US-3)
- **AC-4.1** (US-3) Given a routine fires, when launched, then a new conversation titled `Rutina · <nombre> · dd/mm hh:mm` is created for the routine's agent (the default agent if that agent no longer exists) in the routine's folder (the default folder if empty), and the routine's text is sent as the user's message. [gap]
- **AC-4.2** (US-3) Given the routine finished, when the run ends, then a notification "Rutina «<nombre>» terminada" is shown if the window is not focused; if it failed, "La rutina «<nombre>» falló" with the error; clicking opens that conversation. [gap]
- **AC-4.3** (US-3) Given a routine run reaches a tool that needs approval, when it asks, then the approval waits for the person like in any conversation (no tool is pre-approved by the routine). [gap]
- **AC-4.4** (US-5) Given a routine, when "Ejecutar ahora" is pressed, then it runs immediately, the new conversation list is updated, that conversation opens and the dialog closes; "Ver última ejecución" opens the last conversation. [manual] Check: press both buttons on a routine.
- **AC-4.5** (US-3) Given a routine run through "Ejecutar ahora", when it starts, then its last-run time becomes now (so an interval routine's countdown restarts and a fixed-time routine does not fire again that day if its time already passed). [gap]

### Agent tools (US-4, US-9)
- **AC-5.1** (US-4) Given `create_reminder` with a message and a one-off local time `AAAA-MM-DDTHH:MM`, when run, then a reminder routine is saved with that local time converted to a moment, the answer contains its id (`rutina-xxxxxx`), `list_routines` shows it as «recordatorio», and `delete_routine` removes it. Test: tests/routines-tools.test.ts › "creates a one-off reminder from local time, lists it and deletes it"
- **AC-5.2** (US-4) Given a one-off date more than a minute in the past, when `create_reminder` or `create_routine` runs, then it fails with "Esa fecha ya pasó (…)" and nothing is saved. Test: tests/routines-tools.test.ts › "rejects dates in the past and unknown agents"
- **AC-5.3** (US-4) Given `create_routine` with an unknown agent id, when run, then it fails with "No existe el agente …". Test: tests/routines-tools.test.ts › "rejects dates in the past and unknown agents"
- **AC-5.4** (US-4) Given `create_routine`, when run, then the routine is saved as a task for the calling agent (or the one named) in the given folder (default: the conversation's folder), and the tool's risk is `write`, so it asks for approval in the modes that ask for writes; `create_reminder` has risk `memory`. Test: tests/routines-tools.test.ts › "creates an agent routine in the conversation workspace that needs approval"
- **AC-5.5** (US-4) Given `create_routine` is called in "Pedir aprobación" mode, when the call is made, then the person sees an approval card before the routine is saved, and a refusal saves nothing. [gap]
- **AC-5.6** (US-4) Given an interval, when requested with fewer than 5 minutes, or a time not matching `HH:MM`, or weekdays outside 0–6, or a name shorter than 3 / task shorter than 10 / reminder message shorter than 2 characters, then the call is rejected by validation. [gap]
- **AC-5.7** (US-4) Given a long reminder message, when saved, then its name is the first 57 characters followed by "…" (messages up to 60 characters are kept whole). [gap]
- **AC-5.8** (US-4) Given no routines, when `list_routines` runs, then it answers "No hay recordatorios ni rutinas."; paused ones are marked "pausada". `list_routines` is a read tool and never asks. [gap]
- **AC-5.9** (US-4) Given an unknown id, when `delete_routine` runs, then it fails with "No existe la rutina <id>. Usá list_routines para ver los ids." [gap]
- **AC-5.10** (US-9) Given any agent in any conversation (including voice, Telegram and WhatsApp), when its tools are built, then the four routine tools are available, and none of them needs a working folder. [gap]
- **AC-5.11** (US-9) Given a conversation starts a turn, when the system prompt is built, then it includes the local weekday, date, time and time zone ("Fecha y hora local: …") so the agent can compute dates. [gap]
- **AC-5.12** (US-4) Given a tool saves routines, when it returns, then the next tool call of the same turn already sees the new list, and the main process persists it and the dialog refreshes. [gap]

### Dialog and templates (US-5, US-8)
- **AC-6.1** (US-5) Given the Routines dialog (sidebar button), when it opens, then it lists every item with its name, a badge "recordatorio"/"rutina", "ejecutándose" or "pausada", the schedule text, agent and folder for routines (the message for reminders), "Próxima" and "Última" (relative time or "nunca"), refreshed every 30 seconds. [manual] Check: open the dialog with one reminder and one routine.
- **AC-6.2** (US-5) Given the dialog is empty, when it opens, then it says "Todavía no hay rutinas." [manual] Check: open with no schedules.
- **AC-6.3** (US-5) Given a routine row, when "Activa" is toggled, then the change is saved at once; "Borrar" asks "¿Borrar la rutina «…»?" and deletes only on confirmation; "Editar" opens the editor. [manual] Check: toggle, cancel a delete, then confirm one.
- **AC-6.4** (US-1) Given the buttons "+ Recordatorio" and "+ Rutina con agente", when pressed, then the editor opens with a new reminder (once, tomorrow 09:00) or a new routine (daily 09:00, default agent, default folder); nothing is saved until "Guardar". [manual] Check: open both editors and cancel.
- **AC-6.5** (US-1) Given the editor, when the person chooses "Una vez", "A una hora fija" (time + weekday buttons L M X J V S D, none = todos los días) or "Cada cierto tiempo" (number + horas/minutos), then the schedule changes accordingly; "Guardar" is disabled while the message is empty, a routine has no name, a fixed time is not HH:MM, an interval is under 5 minutes or a date is invalid. [manual] Check: try each kind and an interval of 2 minutes.
- **AC-6.6** (US-1) Given a one-off date in the past, when edited, then the editor warns "Esa fecha ya pasó: va a sonar apenas guardes." [manual] Check: pick yesterday.
- **AC-6.7** (US-8) Given the button "Plantilla: post diario de Instagram", when pressed, then the editor opens (unsaved) with a routine named "Post diario de Instagram", agent `community-manager` if it exists (otherwise the default agent), Monday to Friday at 10:00, and a prompt that asks to create today's post following `marca.md`, avoid topics in `publicaciones.md`, generate the image, write the text, publish it and log it in `publicaciones.md`. [manual] Check: press the button and read the prompt; flow detail in `../012-instagram/spec.md`.
- **AC-6.8** (US-8) Given the template routine runs, when the agent reaches the publish step, then publishing asks for the person's approval whatever the mode (risk `publish`), so the post is not sent unattended. [gap] — see `../012-instagram/spec.md` and `../004-approvals/spec.md`.
- **AC-6.9** (US-5) Given a reminder is saved from the editor, when saved, then its name is its message cut to 60 characters. [manual] Check: save a long reminder and read its row.

### Background and tray (US-7)
- **AC-7.1** (US-7) Given "Al cerrar la ventana, seguir en la bandeja del sistema" is on (default), when the window is closed, then it is hidden, the tray icon stays (menu "Abrir Alma" / "Salir", click shows the window) and the coordinator, routines and reminders keep running. [manual] Check: close the window, create a reminder one minute ahead, wait, see the notification.
- **AC-7.2** (US-7) Given the tray option is off, when the window is closed, then Alma quits and routines stop. [manual] Check: turn the option off and close the window.
- **AC-7.3** (US-7) Given "Abrir al iniciar Windows (minimizada)" is on (default off), when Windows starts, then Alma starts hidden in the tray. [manual] Check: enable, sign out and in.
- **AC-7.4** (US-7) Given Alma is already running, when launched again, then no second instance starts and the existing window is shown. [manual] Check: start Alma twice.
- **AC-7.5** (US-7) Given "Salir" from the tray menu, when chosen, then the app and its coordinator quit and nothing fires until it is opened again. [manual] Check: choose "Salir".

## 6. Business rules
- **BR-1** Schedule kinds: `once` (`at`, epoch ms), `daily` (`time` "HH:MM" local, `days` 0–6, empty = all days), `interval` (`minutes`). (src/shared/types.ts)
- **BR-2** `action` is `reminder` (notify only) or `task` (agent); a routine with no `action` is a task. (src/shared/types.ts)
- **BR-3** The runner checks every 30 seconds and once 5 seconds after start. (src/coordinator/routines.ts)
- **BR-4** Daily: due when today is an allowed day, now is at or past the slot and the last run (or creation) was before the slot. A missed slot of an earlier day is not caught up; a missed slot of today is. (src/shared/schedule.ts)
- **BR-5** Interval: due when now − (last run, or creation if never run) ≥ max(1, minutes) minutes. The first run is one interval after creation, not at creation. (src/shared/schedule.ts)
- **BR-6** Once: due when now ≥ `at` and the routine never ran or last ran before `at`; so a missed one fires late on the next tick after start, and moving its date later re-arms it. (src/shared/schedule.ts)
- **BR-7** A disabled routine is never due, has no next run, but can still be run by hand. (src/shared/schedule.ts, src/coordinator/index.ts)
- **BR-8** A routine never overlaps itself; a run in progress at restart is considered ended. (src/coordinator/routines.ts)
- **BR-9** Run state (`lastRunAt`, `lastThreadId`, `running`) is saved in `routines-state.json` in the data folder, written through a temporary file and a rename; it is kept apart from settings. Entries for deleted routines are not removed. (src/coordinator/routines.ts)
- **BR-10** The routine list itself is part of settings (`settings.routines`), default empty. (src/shared/defaults.ts)
- **BR-11** A reminder is delivered with title "Recordatorio" and body = its message; the desktop notification is always shown (even focused), the in-app alert is persistent, Telegram gets `⏰ <message>` when connected. (src/coordinator/index.ts, src/main/index.ts)
- **BR-12** A task run creates a new conversation per execution titled `Rutina · <name> · dd/mm hh:mm`, using the routine's agent (default agent if missing) and folder (default folder if empty). (src/coordinator/index.ts)
- **BR-13** Task-completion and failure notifications are shown only when the window is not focused; reminders are always shown. (src/main/index.ts)
- **BR-14** Tools: `create_reminder` (risk `memory`), `create_routine` (risk `write`, asks), `list_routines` (risk `read`), `delete_routine` (risk `memory`); all `standalone` (no working folder) and available to every agent. (src/coordinator/tools/routines.ts, src/coordinator/agent.ts)
- **BR-15** Tool schedules: `once.at` is a local "AAAA-MM-DDTHH:MM" (strings with a zone keep it) and must not be more than 60 s in the past; `daily.time` matches `\d{2}:\d{2}`; `interval.minutes` is an integer ≥ 5. The dialog's editor requires ≥ 5 minutes too. (src/coordinator/tools/routines.ts, src/renderer/src/components/RoutinesDialog.tsx)
- **BR-16** Tool field minimums: reminder message ≥ 2 characters, routine name ≥ 3, task ≥ 10. A routine's task text must be self-sufficient: the agent does not see the creating conversation. (src/coordinator/tools/routines.ts)
- **BR-17** Routine ids are `rutina-` + 6 random base-36 characters. (src/coordinator/tools/routines.ts, RoutinesDialog.tsx)
- **BR-18** Agents get "Fecha y hora local: <weekday dd/mm/yyyy hh:mm> (<time zone>)" in their system prompt. (src/coordinator/agent.ts)
- **BR-19** Tray: `background.runInTray` default true, `launchAtLogin` default false; login start passes `--hidden`; one instance only. (src/shared/defaults.ts, src/main/index.ts)

## 7. Constraints and risks
- **Layers touched:** `shared` (`schedule.ts`, `types.ts`, `defaults.ts`), `coordinator` (`routines.ts`, `tools/routines.ts`, `index.ts`, `agent.ts`), `main` (`index.ts`: notifications, tray, login item, single instance, `settings.patch`), `preload`/`shared/desktop-api.ts` (`onReminder`), `renderer` (`RoutinesDialog.tsx`, `App.tsx` alert stack, `SettingsDialog.tsx` "Segundo plano").
- **Messages:** requests `routines.state`, `routines.runNow`; event `routines.state`; coordinator → main `notify` (`title`, `body`, `threadId?`, `always?`) and `settings.patch`; main → renderer `app:reminder`, `app:openThread`, `settings:changed`.
- **Persistence:** `settings.json` (routine definitions; edited from the dialog through `settings:update`, from agents through `settings.patch`); `routines-state.json` (run state).
- **Security / privacy:** an agent may create a recurring task that runs unattended later; `create_routine` asks, but `create_reminder` and `delete_routine` do not, and a routine's own tool calls follow the normal approval policy (they wait for the person; nothing is pre-approved). A reminder's text goes to Telegram when connected. Settings changes from the dialog to routines do not go through the native confirmation of `../017-mcp/spec.md`.
- **Platform:** Windows toasts can be silently dropped (Focus Assist, app identity), hence the in-app alert; times use the computer's local zone and clock; if the computer sleeps or Alma is closed, nothing fires and the missed-run rules of BR-4..6 apply on return. Granularity is 30 seconds.
- **Tests:** schedule logic and tool behavior are tested; the runner, the delivery, the dialog and the tray are not.
