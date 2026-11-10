---
status: ready
---

# 034 — Presence signals: knowing when the person is back

<!-- Written by `planner` on 2026-11-09 from the research report `reports/Alma proactiva sueño y navegador.md` ("El gatillo de la mañana", "Propuesta por etapas") and `research_notes/Alma proactiva sueño y navegador/alma_codebase.md` §4.
Decisions: the wake-signal default (unlock or resume after at least 4 hours away; Home Assistant later) was proposed to the owner on 2026-11-08 and confirmed by the owner on 2026-11-09, marked (owner, confirmed 2026-11-09). On 2026-11-09 the owner accepted the planner's recommendation for every Open Question Q1-Q8 ("acepto todas"), marked (owner Qn), and later the same day for Q9-Q11 ("acepta todas"), marked (owner Qn) as well. No Open Question remains.
First consumer: spec 033 (nightly dream and morning greeting). 033 works without this spec (first message of the day, catch-up at boot); with it, the greeting can reach the person when they unlock, wake or start the PC. Spec 035 (initiatives, not written yet) is the expected second consumer.
Status `ready` set by `planner` on 2026-11-09 on the owner's explicit instruction, given while away and relayed by the calling agent («empezá a hacer las tareas, después vemos si están bien o no, metele a full: plan, tasks y empezá a adelantar»). The owner may set it back to `draft` on return; plan.md and tasks.md would then have to move out with it. -->

## 1. Summary
Alma learns when the person comes back to the computer. The main process listens to the Windows events Electron reports (the computer resuming from sleep, the screen being unlocked), polls how long the system has been idle once a minute (so a return to a PC left unlocked also counts), and tells the coordinator when Alma itself started; it does so through one new typed message. The coordinator keeps the time of the person's last known activity, so a start of Alma after a long absence counts too, whatever started it. A pure rule in `shared` turns those events into at most one **wake signal** a day, the day starting at 02:00 local (the start of 033's night window), only after a real absence of at least 4 hours, and only when a consumer can use it at that moment (a return no consumer can use yet does not use up the day). The signal does nothing visible on its own: it is offered, as "the person is back now" and nothing more, to features inside the coordinator that are on, first the morning greeting of spec 033. Nothing about the person's activity leaves the PC, and nothing is stored while no consumer is on.

## 2. Problem and goal
Alma has no idea whether the person is at the computer. Facts (verified in code and docs):
- No module in `src/` uses Electron's `powerMonitor`: no suspend/resume, lock/unlock or idle time (grep for `powerMonitor|lock-screen|unlock-screen|getSystemIdle` finds nothing; `alma_codebase.md` §4).
- `electron` may only be imported in `src/main/` and `src/coordinator/index.ts` (`docs/architecture.md` §2, `tests/architecture.test.ts`); the coordinator learns things from main only through `ParentToCoordinator` messages (`src/shared/types.ts`: `init`, `settings`, `client`, `host.result`, `voice.trigger`).
- Electron's `user-did-become-active` exists only on macOS; on Windows the available events are `suspend`, `resume`, `lock-screen`, `unlock-screen` and `powerMonitor.getSystemIdleTime()`.
- Home Assistant presence (`person`, `device_tracker`) is not modeled: Alma's thing domains do not include them (`src/shared/home.ts`).
- On hardware with Modern Standby, Windows wake timers are not reliably honored (report, "Cuándo dormir"), so a feature cannot count on the PC being awake at a set hour; it has to act when the person returns.
- A PC shut down overnight gives no `unlock-screen` or `resume` at all; a PC left unlocked gives no lock event, only a drop of the idle time.

Done means: when the person returns to the PC after a long absence, the coordinator knows it once that day, decided by a tested pure function; returns after short breaks change nothing; the layer rules hold; and the only stored trace of the person's activity is the minimum the rule needs, kept only while a consumer is on.

## 3. Scope
**In:**
- Listening in `src/main/` to `suspend`, `resume`, `lock-screen` and `unlock-screen`, and polling the system idle time once a minute.
- Telling the coordinator that Alma started, and keeping the last known activity time across quits.
- One new `ParentToCoordinator` message (typed in `shared/types.ts`, validated with Zod at the coordinator boundary).
- A pure function in `shared` that decides whether an event is the day's wake signal (threshold, once per day, day boundary at 02:00).
- The minimum persisted state (the date of the last wake signal and the last known activity time), only while a consumer is on.
- Offering the wake signal to features inside the coordinator (033 first).
- Clearing that state with «Borrar mi historial».
- Docs and privacy entries (§7.1), in the same PR as the implementation.

**Out (and why):**
- Home Assistant presence (motion, `person`, phone alarm): Alma does not model those entities yet; proposed for later (report, owner default).
- Doing anything with the signal (greeting, initiatives): specs 033 and 035.
- Quiet hours and Windows Focus: spec 035 (033 Q1).
- Any screen, switch or setting of its own: the threshold is a constant in v1 and detection follows its consumers (Q5, Q6). A threshold setting can come with spec 035 if people ask.
- A log or history of when the person was active, and the presence state in «Exportar mis datos»: not needed by any consumer (Q7).
- Replaying an event that arrived while the coordinator was down (Q8).
- macOS or Linux events: Alma is a Windows app.
- Waking the computer (wake timers, `powerSaveBlocker`): unreliable on Modern Standby, and not asked for.

## 4. Users and stories
- **US-1** As a person who comes back to the PC in the morning, I want Alma to notice I am back without my having to write to her, whether I unlock it, wake it, turn it on or just touch it, so that what she prepared (spec 033) reaches me at that moment.
- **US-2** As a person, I want Alma to notice it at most once a day and only after a real absence, so that unlocking the PC after lunch or a meeting does not trigger anything.
- **US-3** As a person, I want my activity pattern to stay on my PC and be kept no longer than needed, so that Alma does not become a log of when I sit at my computer.
- **US-4** As the maintainer, I want the OS events read in `main` and the decision made by a pure tested function in `shared`, so that the layer rules hold and the rule is testable without Electron.

## 5. Acceptance criteria
Tests name the id: `it('AC-1.1 …')`. No test exists yet, so testable criteria carry `[gap]` until the implementation replaces each tag with its `Test:` citation.

### Events from main (US-1, US-4)
- **AC-1.1** (US-1) Given Alma running, when Windows reports `resume` or `unlock-screen`, then main sends the coordinator exactly one presence message carrying the kind of event and the length of the absence it ends (from the last input before the matching `lock-screen` or `suspend`, using the system idle time at that moment), and nothing else. Test: tests/presence-main.test.ts › "AC-1.1 (034) resume and unlock post one event with the measured absence"
- **AC-1.2** (US-1) Given `lock-screen` or `suspend`, when it happens, then main notes the moment of the last input before it (now minus the system idle time) so the absence can be measured on return; a `resume` followed by an `unlock-screen` for the same absence is measured from the same start. Test: tests/presence-main.test.ts › "AC-1.2 (034) lock and suspend note the last input; resume then unlock share the start"
- **AC-1.3** (US-4) Given a presence message, when the coordinator receives it, then it is validated with a Zod schema at the boundary; a malformed one (unknown kind, a negative or non-finite absence, extra keys) is ignored, nothing acts on it, and the coordinator log records the rejection without the payload. Test: tests/presence-coordinator.test.ts › "AC-1.3 (034) a malformed presence message is ignored and logged without its payload"; Test: tests/presence.test.ts › "AC-1.3 (034) the schema"
- **AC-1.4** (US-1) Given the coordinator is not running when an event happens (starting, restarting after a crash), then the event is dropped: not queued, not replayed by main when the coordinator is ready, and no error reaches the person. [gap]
- **AC-1.5** (US-4) Given the source tree, then `powerMonitor` is used only under `src/main/`; the existing layer rule (`electron` only in `main/` and `coordinator/index.ts`) already fails if it is imported elsewhere, and the plan names the test case. Test: tests/architecture.test.ts › "AC-1.5 (034) powerMonitor only under src/main"
- **AC-1.6** (US-1) Given Alma running and the screen not locked, then main reads the system idle time at most once a minute; when the person touches the PC after a period without input, the coordinator learns that return and the length of the period without input. Test: tests/presence-main.test.ts › "AC-1.6 (034) a poll while unlocked detects a return after a period without input"
- **AC-1.7** (US-1) Given Alma starts, then the coordinator learns that it started; how it was started (Windows login or by hand) is not sent and does not change the decision (BR-2). Test: tests/presence.test.ts › "AC-1.7 (034) a start is one message with no launch detail"

### The wake-signal rule (US-2, US-4)
- **AC-2.1** (US-2) Given an `unlock-screen`, a `resume` or an idle return that ends an absence of 4 hours or more, and no wake signal yet in the current day, when the rule runs, then it returns a wake signal and the coordinator offers it once to the consumers that are on. Test: tests/presence.test.ts › "AC-2.1 (034) a 4-hour absence gives the day's signal"; Test: tests/presence-coordinator.test.ts › "AC-2.1 (034) the signal is offered once to the consumers that are on"
- **AC-2.2** (US-2) Given an absence shorter than 4 hours, when the rule runs, then no wake signal. Test: tests/presence.test.ts › "AC-2.2 (034) a shorter absence gives none"
- **AC-2.3** (US-2) Given a wake signal already given in the current day, when a later event ends another absence of 4 hours or more, then no second signal that day. Test: tests/presence.test.ts › "AC-2.3 (034) a second qualifying event the same day gives none"
- **AC-2.4** (US-2) Given the day starts at 02:00 local (the start of 033's night window), when events fall on each side of 02:00, then each day gets at most one signal; a return at 00:30 after an evening away belongs to the previous day and does not use up the next morning's signal. Test: tests/presence.test.ts › "AC-2.4 (034) the day starts at 02:00"; Test: tests/presence.test.ts › "AC-2.4 (034) a return at 00:30 does not use up the next morning"
- **AC-2.13** (US-2) Given a qualifying event (AC-2.1) at or after 02:00 when no consumer that is on can use a wake signal yet (for 033: the day's greeting is not written and no catch-up dream is running), when the rule runs, then no signal is offered and the day's signal is not used up: a later qualifying event the same day can still give it (BR-12). Test: tests/presence.test.ts › "AC-2.13 (034) a signal no consumer can use is not used up"; Test: tests/presence-coordinator.test.ts › "AC-2.13 (034) the service asks canUse before using up the day"
- **AC-2.5** (US-2) Given a wake signal given today and Alma restarted afterwards, when a new qualifying event arrives the same day, then no second signal: the date of the last signal is persisted. Test: tests/presence-coordinator.test.ts › "AC-2.5 (034) the last signal date survives a restart"
- **AC-2.6** (US-2) Given an `unlock-screen` whose absence start main never saw (Alma started while the screen was locked), when it arrives, then it is not a wake signal. Test: tests/presence.test.ts › "AC-2.6 (034) an unlock with an unknown start is not a signal"; Test: tests/presence.test.ts › "AC-2.6 (034) an unknown start has no absence"
- **AC-2.7** (US-1) Given Alma starts, at Windows login or by hand, and the last known activity is 4 hours old or more, then the start is a wake signal (subject to AC-2.3 and AC-2.13); given the last known activity is less than 4 hours old (a quick reboot after an update included), then it is not; given no last known activity (the first start after installing, or the first start after a consumer was turned on), then it is not (BR-2, BR-11). Test: tests/presence.test.ts › "AC-2.7 (034) a start is judged by the last known activity alone"; Test: tests/presence-coordinator.test.ts › "AC-2.7 (034) a start uses the persisted last activity"; Test: tests/presence-coordinator.test.ts › "AC-2.7 (034) a start with nothing persisted is not a signal"
- **AC-2.8** (US-1) Given the person returns to an unlocked PC after 4 hours or more without input (no lock, no sleep), then the drop of the idle time (AC-1.6) is a wake signal, subject to AC-2.3. Test: tests/presence-main.test.ts › "AC-2.8 (034) a return to an unlocked PC after 4 hours posts an idle return"; Test: tests/presence-main.test.ts › "AC-2.8 (034) a late poll right after a resume does not post a second return"; Test: tests/presence.test.ts › "AC-2.8 (034) an idle return after 4 hours is a signal"
- **AC-2.9** (US-2) Given the absence is measured, then it is elapsed time, not a difference of wall-clock readings, so a daylight-saving change or a clock correction during the absence neither creates nor hides a signal; a start of absence later than the event counts as no absence. Test: tests/presence.test.ts › "AC-2.9 (034) absence is elapsed time"; Test: tests/presence.test.ts › "AC-2.9 (034) a clock moved back to an earlier day gives no second signal"
- **AC-2.10** (US-4) Given the rule, then it is one pure exported function in `shared` taking the event (kind and absence, or for a start the persisted last known activity), the current local time, the persisted state and whether a consumer can use a signal now, and returning the decision and the new state; its tests cover each criterion of this group without Electron. Test: tests/presence.test.ts › "AC-2.10 (034) decideWake is pure"
- **AC-2.11** (US-3) Given no consumer is on (033's dream switch off and no other consumer), then main still forwards events, and the coordinator persists nothing and offers nothing. Test: tests/presence-coordinator.test.ts › "AC-2.11 (034) with no consumer on nothing is persisted or offered"; Test: tests/presence-coordinator.test.ts › "AC-2.11 (034) the state is deleted when the last consumer turns off"
- **AC-2.12** (US-2) Given the 4-hour threshold, then it is a constant, not a setting; the plan provides a shorter test threshold that cannot ship (AC-4.1). Test: tests/presence.test.ts › "AC-2.12 (034) the test threshold only applies unpackaged"

### Privacy (US-3)
- **AC-3.1** (US-3) Given presence events over any period, then what is persisted is only the date of the last wake signal and the time of the last known activity, and only while a consumer is on; there is no log or history of events. Test: tests/presence-coordinator.test.ts › "AC-3.1 (034) only the two fields are written"; Test: tests/presence.test.ts › "AC-3.1 (034) the persisted state holds only the two fields"
- **AC-3.2** (US-3) Given a wake signal, then a consumer receives only "the person is back now" (no event kind, absence length or time); nothing about it is sent to a model provider, Telegram, the paired phone or any other third party; the audit trail gets no entry for presence events. Test: tests/presence-coordinator.test.ts › "AC-3.2 (034) a consumer gets no detail and nothing reaches the audit trail"
- **AC-3.3** (US-3) Given «Exportar mis datos», then the persisted presence state is not exported; given «Borrar mi historial», then it is cleared. Test: tests/presence-coordinator.test.ts › "AC-3.3 (034) export leaves the presence state out and erase clears it"

### Platform (US-1)
- **AC-4.1** (US-1) [manual] On a real Windows 11 laptop with Modern Standby and on a desktop without it: lock the screen, wait past the threshold (the plan provides a shorter test threshold that cannot ship), unlock, and see one wake signal in the coordinator's debug log; sleep and resume the same way; leave the PC unlocked past the threshold and touch it; shut down and log in again; check a short break gives none. Records which of `suspend`/`resume` fire under Modern Standby, since `unlock-screen` may be the only one that does.

## 6. Business rules
(owner, confirmed 2026-11-09) marks the default proposed on 2026-11-08 and confirmed by the owner on 2026-11-09. (owner Qn) marks the owner's answer of 2026-11-09 to Open Question Qn (the planner's recommendation, accepted). The others apply an existing written rule.

- **BR-1** (Constitution IV; `docs/architecture.md`) `powerMonitor` is read only in `src/main/`. The decision is a pure function in `shared`. The coordinator applies it and offers the signal to its features. The message type lives in `shared/types.ts` (`ParentToCoordinator`) and is validated with Zod where the coordinator receives it.
- **BR-2** (owner, confirmed 2026-11-09; owner Q2, Q3, Q9) The events that can end an absence are `unlock-screen`, `resume`, a drop of the system idle time polled once a minute (a return to an unlocked PC), and Alma starting. For a start, the threshold alone decides, whatever started Alma (Windows login or by hand): a last known activity 4 hours old or more is a signal, less is not. Home Assistant presence is out of scope.
- **BR-3** (owner, confirmed 2026-11-09; owner Q5) An absence counts when it lasted 4 hours or more, measured as elapsed time from the last input before `lock-screen`, `suspend` or the idle period (or from the last known activity, for a start) to the event that ends it. The threshold is a constant in v1.
- **BR-4** (owner, confirmed 2026-11-09; owner Q1) At most one wake signal per day. The day starts at 02:00 local, the start of 033's night window, so the signal belongs to the morning after the night the dream covers.
- **BR-5** (owner Q2) The date of the last wake signal and the time of the last known activity are persisted, so a restart does not give a second signal (BR-4 would not hold otherwise) and a start of Alma can measure the absence. Nothing else about presence is persisted.
- **BR-6** (Constitution V) This spec adds no agent tool, so no `ToolRisk`; no secret; no new third party. A new category of personal data (activity pattern) is documented in `docs/security/PRIVACY.md` in the same PR.
- **BR-7** (owner Q7) The wake signal is offered to consumers inside the coordinator only, as "the person is back now" with no time or length; it is never sent to the renderer, the phone, a channel, a model provider or the audit trail by this spec.
- **BR-8** (owner Q6) Presence detection has no switch of its own: main always forwards events (they are not stored), and the coordinator persists and acts only while a consumer is on.
- **BR-9** (owner Q7) The persisted presence state is not exported by «Exportar mis datos» (it is a date and a time) and is cleared by «Borrar mi historial».
- **BR-10** (owner Q8) An event that arrives while the coordinator is starting or restarting is dropped; main does not replay it.
- **BR-11** (owner Q4, Q10) An `unlock-screen` whose `lock-screen` main never saw has no measurable absence and is not a wake signal; neither is a start with no known last activity (the first start after installing, or after a consumer was turned on, since nothing is persisted while no consumer is on, BR-8). A later event or the first message of the day (033) covers those cases.
- **BR-12** (owner Q11; one answer with 033 Q32) A signal that no consumer that is on can use at that moment is not offered and does not use up the day's signal. The coordinator asks its consumers whether they can use one now (for 033: the day's greeting is written and not delivered, or a catch-up dream is running); only a signal offered to a consumer that can use it counts as the day's one.

## 7. Constraints and risks
- **Layers touched:** `main` (listening to `powerMonitor`, polling the idle time, measuring the absence, telling of a start, sending the message); `shared` (message type, Zod schema, the pure rule); `coordinator` (receiving, validating, persisting the state while a consumer is on, offering the signal, clearing it with «Borrar mi historial»; `coordinator/index.ts` is where `parentPort` messages arrive). `renderer`: none.
- **Security / privacy:** no tool, no `ToolRisk`, no secret, no third party. New personal data: the date the person last returned and the time of their last known activity, kept on the local disk only while a consumer is on, not exported, cleared by «Borrar mi historial». The signal can be spoofed only by someone at the PC's keyboard, who could just as well write to Alma. `docs/security/PRIVACY.md` gains a row.
- **Performance / platform:** events can arrive in bursts (`resume` then `unlock-screen`, then the idle drop); the once-a-day rule absorbs them. Under Modern Standby `suspend`/`resume` may not fire, which is why `unlock-screen` and the idle drop matter (AC-4.1). The idle poll runs at most once a minute and must be cheap. Local time zone and clock, as routines use (spec 018).

### 7.1 Docs to update (in the implementation PR, not in this draft)
| Doc | Change |
|---|---|
| `docs/context.md` | Term **Wake signal** written on 2026-11-09 and updated the same day with Q9-Q11 (a start counts by the threshold alone; no known last activity is no signal; a signal no consumer can use is not used up). |
| `docs/security/PRIVACY.md` | New row: activity pattern (the date of the last return and the last known activity time; kept locally only while a consumer is on; not exported; cleared by «Borrar mi historial»; sent to nobody). |
| `docs/references/ipc-messages.md` | The new `ParentToCoordinator` message. |
| `docs/references/limits.md` | The 4-hour threshold and the once-a-minute idle poll. |
| `docs/modules/` | A short section in the module doc that owns the coordinator side (plan decides which). |

## 8. Open Questions
Unchecked items block `ready`. Q1-Q8 were answered by the owner on 2026-11-09, who accepted the planner's recommendation for every one ("acepto todas"); Q9-Q11, found while folding those answers into the body, were answered the same way later that day ("acepta todas"). Each line records the decision and where it landed. None is open.

- [x] Q1 Day boundary. Decision (owner, 2026-11-09): the day starts at the start of the night window (02:00, spec 033), so the signal belongs to the morning after the night the dream covers. (BR-4, AC-2.4.)
- [x] Q2 Alma's own start. Decision (owner, 2026-11-09): a wake signal when started at Windows login; not when started by hand after less than the threshold; the last known activity time is persisted across quits. (BR-2, BR-5, AC-1.7, AC-2.7; the remaining cases are Q9 and Q10.)
- [x] Q3 Return without lock. Decision (owner, 2026-11-09): the drop of the idle time counts, polled once a minute. (BR-2, AC-1.6, AC-2.8.)
- [x] Q4 Unknown start of absence. Decision (owner, 2026-11-09): not a signal; a start at login and the first message of the day cover that case. (BR-11, AC-2.6.)
- [x] Q5 Threshold as a setting. Decision (owner, 2026-11-09): a constant in v1; a setting can come with spec 035 if people ask. (BR-3, AC-2.12.)
- [x] Q6 Switch. Decision (owner, 2026-11-09): no switch of its own; main always forwards events (not stored), and the coordinator persists and acts only while a consumer is on. (BR-8, AC-2.11.)
- [x] Q7 What leaves or stays. Decision (owner, 2026-11-09): consumers get only "the person is back now"; nothing to providers, nothing in the audit trail, not exported, cleared by «Borrar mi historial». (BR-7, BR-9, AC-3.2, AC-3.3.)
- [x] Q8 Events while the coordinator is down. Decision (owner, 2026-11-09): dropped; the next event or the first message of the day covers it. (BR-10, AC-1.4.)

### Found while recording the answers
- [x] Q9 The start cases Q2 left (a start by hand after 4 hours or more; a start at login after less). Decision (owner, 2026-11-09): the threshold decides both, whatever started Alma: 4 hours or more is a signal, less is not. (BR-2, AC-1.7, AC-2.7.)
- [x] Q10 No known last activity (first start after installing, or after 033's dream is turned on). Decision (owner, 2026-11-09): not a signal, like an unknown start of absence; the first message of the day covers it. (BR-11, AC-2.7.)
- [x] Q11 A signal before a consumer can use it (a return at or after 02:00 before 033's greeting is written). Decision (owner, 2026-11-09; the same answer as 033 Q32): a signal no consumer could use is not used up. (BR-12, AC-2.4, AC-2.13, AC-2.10.)
