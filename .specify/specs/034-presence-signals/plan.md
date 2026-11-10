# 034 — Plan

Spec 034 is `ready` (no Open Questions; set on the owner's relayed instruction of 2026-11-09, see the spec header). This plan does not change §1 to §8 of the spec. Task ids are in `tasks.md`. Where the spec leaves a technical detail open, §10 lists the reading this plan builds on for the human to confirm; none answers a business rule.

## 0. Coordination

- **034 is built before 033.** 033 is its first consumer and imports `dayKey` from this spec's shared module. 034 ships with an empty consumer list, so on its own it changes nothing the person can see (AC-2.11).
- The working tree holds unrelated uncommitted work from another session (`src/main/attach.ts`, `src/coordinator/channels/remote/*`, `src/shared/remote/api.ts`, …). 034 touches none of those files except `src/main/index.ts` and `src/coordinator/index.ts`, and only with small additions. Rebase on that work before T1.

## 1. Approach

Main listens to `powerMonitor` (`lock-screen`, `unlock-screen`, `suspend`, `resume`) and polls `powerMonitor.getSystemIdleTime()` once a minute. A pure tracker in `src/main/presence.ts` (no `electron` import) turns those readings into presence events with the measured absence; `index.ts` is the thin shell that feeds it and posts one new `ParentToCoordinator` message, `presence`. The coordinator validates the message with Zod and hands it to a small `PresenceService`, which applies the pure once-a-day rule `decideWake` from `src/shared/presence.ts`, persists the two allowed values only while a consumer is on, and offers "the person is back now" to the consumers that can use it.

**Rejected alternatives:** deciding in main (main would need to know the consumers, which live in the coordinator; the rule would sit far from its only users); a `presence` setting or switch (the owner decided none, BR-8); queueing events while the coordinator restarts (the owner decided they are dropped, BR-10); telling the coordinator how Alma was started (Q9 made it irrelevant: the threshold alone decides).

**ADR:** none. Everything here is easy to reverse: one message type and a two-field state file.

**Dependencies:** none new.

## 2. Layers touched

| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | new `src/shared/presence.ts`; changed `src/shared/types.ts` (`ParentToCoordinator` +1 member) | the rule, the day boundary, the message schema: used by main (types), coordinator (rule) and later 033 (`dayKey`) |
| main | new `src/main/presence.ts` (pure tracker, imports only `shared`); changed `src/main/index.ts` (powerMonitor listeners, idle poll, the `start` message) | only main may use `electron`'s `powerMonitor` |
| coordinator | new `src/coordinator/presence.ts` (`PresenceService`); changed `src/coordinator/index.ts` (one `case 'presence'`, init, `privacy.erase`) | applies the rule, owns the state file, knows the consumers |
| renderer | none | the spec adds no screen (BR-8) |

No new arrow breaks `docs/architecture.md`: `src/main/presence.ts` imports only `../shared/presence`; `src/coordinator/presence.ts` imports only `shared` and `node:fs`/`node:path`.

## 3. Contracts

Signatures and types only.

### 3.1 `src/shared/presence.ts`

```ts
export const WAKE_ABSENCE_MS: number          // 4 h (BR-3), a constant
export const IDLE_POLL_MS: number             // 60 000 (BR-2)
export const DAY_START_HOUR: number           // 2, the start of 033's night window (BR-4)

/** The threshold in force: WAKE_ABSENCE_MS, or ALMA_PRESENCE_THRESHOLD_MS when the app is not packaged (AC-2.12). */
export function presenceThreshold(packaged: boolean, env: Readonly<Record<string, string | undefined>>): number

/** The local date (YYYY-MM-DD) of the day `now` belongs to; the day starts at 02:00 local (BR-4). */
export function dayKey(now: Date): string

/** Elapsed ms between two epoch readings; null when the start is unknown or later than the end (AC-2.6, AC-2.9). */
export function absenceBetween(start: number | undefined, end: number): number | null

export type PresenceEvent =
  | { kind: 'unlock' | 'resume' | 'idle-return'; absenceMs: number | null }   // null = start of absence never seen (BR-11)
  | { kind: 'start' }                                                         // Alma started; nothing about how (AC-1.7)
  | { kind: 'active' }                                                        // input seen in the last poll: keeps the last known activity

export const PresenceEventSchema: z.ZodType<PresenceEvent>   // strict: unknown kind, extra keys, negative or non-finite absence rejected (AC-1.3)

export interface PresenceState { lastWakeDay?: string; lastActivityAt?: number }   // the only persisted fields (AC-3.1)
export const PresenceStateSchema: z.ZodType<PresenceState>                         // for the file read at boot

export interface WakeInput {
  event: Exclude<PresenceEvent['kind'], 'active'>
  absenceMs: number | null        // for 'start', the caller passes absenceBetween(state.lastActivityAt, now)
  now: Date
  state: PresenceState
  canUse: boolean                 // some consumer that is on can use a signal now (BR-12)
  thresholdMs: number
}
/** BR-2, BR-3, BR-4, BR-11, BR-12. Pure; `state.lastWakeDay` changes only when `wake` is true. */
export function decideWake(input: WakeInput): { wake: boolean; state: PresenceState }
```

### 3.2 `src/shared/types.ts`

```ts
export type ParentToCoordinator =
  | /* existing members */
  | { type: 'presence'; event: PresenceEvent }   // validated with PresenceEventSchema in the coordinator (AC-1.3)
```

### 3.3 `src/main/presence.ts` (pure, no `electron`)

```ts
export interface TrackerState { locked: boolean; awaySince?: number; lastInputAt?: number }
export type TrackerInput =
  | { type: 'lock' | 'suspend'; now: number; idleSec: number }
  | { type: 'unlock' | 'resume'; now: number }
  | { type: 'poll'; now: number; idleSec: number }
/** One step: the new state and the events to post (zero, one, or for a poll at most two: an idle return and `active`). */
export function trackPresence(state: TrackerState, input: TrackerInput): { state: TrackerState; events: PresenceEvent[] }
```

Rules the tracker encodes (AC-1.1, AC-1.2, AC-1.6): `lock`/`suspend` set `awaySince = now − idleSec·1000` unless already set (the earliest start wins, so `suspend` after `lock` keeps the lock's start); `resume` emits `resume` with `absenceBetween(awaySince, now)` and clears `awaySince` only when not locked; `unlock` emits `unlock` and clears; a `poll` while locked emits nothing; a `poll` while unlocked computes `lastInput = now − idleSec·1000` and emits `idle-return` when `lastInput − previous lastInputAt ≥ IDLE_POLL_MS` (a period with no input of at least one poll), and `active` when `idleSec·1000 < IDLE_POLL_MS`.

### 3.4 `src/coordinator/presence.ts`

```ts
export interface PresenceConsumer {
  enabled(): boolean           // is the feature on (033: the dream switch)
  canUse(): boolean            // could it use a signal right now (033: greeting written and undelivered, or a catch-up dream running)
  wake(): void                 // "the person is back now": no kind, time or length (BR-7)
}
export interface PresenceDeps {
  file: string                 // <userData>/presence.json
  now(): Date
  thresholdMs: number
  consumers(): readonly PresenceConsumer[]
  log(line: string): void      // identifiers only, never the payload (AC-1.3)
}
export class PresenceService {
  constructor(deps: PresenceDeps)
  receive(raw: unknown): void  // validate, update last activity, decide, offer; never throws
  consumersChanged(): void     // deletes the state file when no consumer is on (AC-2.11, AC-3.1); call on every settings push
  clear(): void                // «Borrar mi historial» (AC-3.3)
}
```

## 4. Data and persistence

- `<userData>/presence.json`: `{ lastWakeDay?: string, lastActivityAt?: number }` only (AC-3.1). Written atomically (temp file and rename, as `RoutineRunner.save`), mode `0o600`, only while at least one consumer is `enabled()`. Written when `lastWakeDay` changes and at most once per `active` message (once a minute). A file that fails `PresenceStateSchema` is treated as empty and logged without its content.
- No consumer on: nothing is written and an existing file is deleted (`consumersChanged`). With 034 alone there is no consumer, so the file never appears.
- «Exportar mis datos»: `EXPORTED` in `src/coordinator/privacy.ts` stays as is (it does not list `presence.json`); a test pins that (AC-3.3). «Borrar mi historial»: `privacy.erase` calls `presence.clear()`, which deletes the file and the in-memory state.
- Nothing from a previous version exists to migrate.

## 5. Dependency injection

- `trackPresence` is a pure reducer: tests feed sequences of inputs with plain numbers; `index.ts` holds the state and posts the events.
- `PresenceService` receives the file path, the clock, the threshold and the consumer list; tests use a temp dir (`mkdtempSync`), a fake clock and fake consumers that record `wake()` calls.
- `index.ts` (coordinator) builds the service at `init` with `presenceThreshold(packaged, process.env)` and `consumers: () => []` (033 adds the greeting consumer).
- Main: `startCoordinator()` posts `{ type: 'presence', event: { kind: 'start' } }` right after `init`, only for the first start of the app process (a coordinator restart after a crash is not Alma starting). Every post goes through `postToCoordinator`, which drops it when there is no coordinator process (AC-1.4); a message that reaches a new process before its `init` finds no service and is ignored.

## 6. Test strategy

Test titles carry `AC-x.y (034)` because ids repeat across specs. Files: **P** `tests/presence.test.ts` (shared rule), **M** `tests/presence-main.test.ts` (tracker), **C** `tests/presence-coordinator.test.ts` (service), **A** `tests/architecture.test.ts` (existing).

| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1 | M → `AC-1.1 (034) resume and unlock post one event with the measured absence` | resume with no prior suspend (null absence); two unlocks in a row (second carries null) |
| AC-1.2 | M → `AC-1.2 (034) lock and suspend note the last input; resume then unlock share the start` | suspend after lock keeps the lock's start; idle 0 at lock |
| AC-1.3 | C → `AC-1.3 (034) a malformed presence message is ignored and logged without its payload` ; P → `AC-1.3 (034) the schema` | unknown kind, `absenceMs: -1`, `NaN`, `Infinity`, a string, extra key, missing kind, `null`, a marker string in the payload absent from the log |
| AC-1.4 | No unit test: the drop is `postToCoordinator`'s existing `coordinator?.` (no process, nothing sent) and the coordinator's `presence?.` (no service before `init`), both in `index.ts` shells with `electron`. Checked by review in T8/T12 and in the AC-4.1 manual run; the tag stays `[gap]` at close-out (a known, listed gap) | message during restart |
| AC-1.5 | A → `AC-1.5 (034) powerMonitor only under src/main` (a negative fixture `src/coordinator/presence.ts` importing `powerMonitor` from `electron` is flagged by the existing rule) | — |
| AC-1.6 | M → `AC-1.6 (034) a poll while unlocked detects a return after a period without input` | poll while locked emits nothing; idle exactly one poll; idle growing without return; clock jump between polls |
| AC-1.7 | M/C → `AC-1.7 (034) a start is one message with no launch detail` (the schema has no field for it) | — |
| AC-2.1 | P → `AC-2.1 (034) a 4-hour absence gives the day's signal` ; C → `AC-2.1 (034) the signal is offered once to the consumers that are on` | consumer off not called; two consumers both called |
| AC-2.2 | P → `AC-2.2 (034) a shorter absence gives none` | 4 h − 1 ms; exactly 4 h gives one |
| AC-2.3 | P → `AC-2.3 (034) a second qualifying event the same day gives none` | resume then unlock burst |
| AC-2.4 | P → `AC-2.4 (034) the day starts at 02:00` | 01:59 and 02:00; 00:30 return belongs to the previous day; DST spring-forward and fall-back nights |
| AC-2.5 | C → `AC-2.5 (034) the last signal date survives a restart` | new service on the same file |
| AC-2.6 | P → `AC-2.6 (034) an unlock with an unknown start is not a signal` | `absenceMs: null` for every kind |
| AC-2.7 | P → `AC-2.7 (034) a start is judged by the last known activity alone` ; C → `AC-2.7 (034) a start uses the persisted last activity` | 4 h old yes; 3 h 59 m no (quick reboot); none persisted no; consumer just turned on (no activity yet) no |
| AC-2.8 | M → `AC-2.8 (034) a return to an unlocked PC after 4 hours posts an idle return` ; P covers the decision | PC asleep between polls (the resume path wins, the late poll does not double) |
| AC-2.9 | P → `AC-2.9 (034) absence is elapsed time` | DST change during the absence; start later than the event → no absence; epoch math only (see §10 G1) |
| AC-2.10 | P → `AC-2.10 (034) decideWake is pure` | the input objects are not mutated; same input same output |
| AC-2.11 | C → `AC-2.11 (034) with no consumer on nothing is persisted or offered` | existing file deleted when the last consumer turns off |
| AC-2.12 | P → `AC-2.12 (034) the test threshold only applies unpackaged` | packaged with env set → 4 h; unpackaged with garbage env → 4 h; unpackaged with `60000` → 60 000 |
| AC-2.13 | P → `AC-2.13 (034) a signal no consumer can use is not used up` ; C → same at the service | `canUse` false at 02:10 then true at 07:00 the same day → one signal at 07:00 |
| AC-3.1 | C → `AC-3.1 (034) only the two fields are written` | after a burst of events the file has exactly `lastWakeDay` and `lastActivityAt` |
| AC-3.2 | C → `AC-3.2 (034) a consumer gets no detail and nothing reaches the audit trail` | `wake()` takes no argument (type); `audit` spy called 0 times |
| AC-3.3 | C → `AC-3.3 (034) export leaves the presence state out and erase clears it` (calls `exportPersonalData` on a temp data dir holding `presence.json`, then `clear()`) | — |
| AC-4.1 | manual (spec §5) with `ALMA_PRESENCE_THRESHOLD_MS=60000` in `pnpm run dev` | — |

## 7. Security and privacy impact

- No tool, no `ToolRisk`, no secret, no third party (BR-6). Nothing about presence goes to the renderer, the phone, a channel, a provider or the audit trail (BR-7).
- New personal data: the date of the last wake signal and the time of the last known activity, local only, only while a consumer is on, not exported, cleared by «Borrar mi historial». `docs/security/PRIVACY.md` gains a row in §1 (T13).
- Trust: the message comes from main over `parentPort` (same-process-family trust, `docs/references/ipc-messages.md`); it is validated anyway (AC-1.3) so a bug in main cannot make the coordinator act on garbage.
- Spoofing: only someone at the keyboard can produce the events (spec §7); nothing to add to `RISKS.md` beyond a line under the existing local-access assumptions, if the human wants one (not planned).

## 8. Rollout

No setting. Shipped with 034 alone it is inert: main forwards events, the coordinator has no consumer, nothing is stored. It becomes active when 033's dream switch is on. To test by hand: `ALMA_PRESENCE_THRESHOLD_MS=60000 pnpm run dev` (ignored by a packaged build).

## 9. Decisions flagged for the human

1. The `start` event is sent for the first coordinator start of each app process only; a coordinator crash and restart is not "Alma starting". Reversible in one line.
2. The tracker forwards an `idle-return` only after a period without input of at least one poll (60 s) and an `active` heartbeat every poll while the person is active; both are traffic filters, not business rules (the 4-hour rule stays in `decideWake`).

## 10. Provisional readings (to confirm; not decided)

| # | Where | Gap | Reading used |
|---|---|---|---|
| G1 | AC-2.9 | "Elapsed time, not a difference of wall-clock readings": a monotonic clock does not survive a restart (needed for a start, AC-2.7) and is not reliable across sleep on every Windows machine | Absence is the difference of UTC epoch milliseconds (`Date.now()`), which a daylight-saving change cannot move; a start later than the event counts as no absence. A large forward clock correction during an absence remains a residual (it could lengthen a measured absence); AC-4.1's manual run records whether that matters |
| G2 | BR-5, AC-3.1 | How often the last known activity is written | Once per `active` message (at most once a minute) while a consumer is on; precision matches the poll |
| G3 | AC-1.4, BR-10 | A message posted to a freshly restarted coordinator before its `init` | Ignored (the service does not exist yet); main never re-sends |
| G4 | BR-8, AC-3.1 | "Kept only while a consumer is on" when the last consumer is turned off | The file is deleted at that moment (`consumersChanged`) |
