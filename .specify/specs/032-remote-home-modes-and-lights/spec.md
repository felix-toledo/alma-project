---
status: draft
---

# 032 — Home from the phone: modes and light settings

<!-- Written by `planner` on 2026-11-08 from the owner's request (Spanish): in the phone app's Casa tab, "personalize more": activate house modes (Home Assistant scenes) and, for lights, set color when applicable; the maintainer added brightness and color temperature.
All 16 Open Questions were answered by the owner on 2026-11-08 (Q2, Q3, Q7, Q8, Q10 one by one; the rest by accepting the planner's recommended default as written). Each answer is written into §4-§6 and ticked in §8. No unchecked question remains: the spec can go to the human for `ready`. Only the human sets `status: ready`; the line to change is the `status:` line above. No plan.md or tasks.md until then.
Number: 031 stays soft-reserved for phone attachments (030 Q10); 032 is the next safe number.
Depends on 026 (`ready`, code done) and 028 (`ready`). Amends them explicitly in §7.1; it edits neither. -->

## 1. Summary
In the Home tab of the phone app (spec 026) the person can (1) activate one of the house's modes (the Home Assistant scenes the PC already knows as "Noche", "Me fui", "Cine") with a tap and (2) for a light that is on and supports it, set its brightness, its color (one of 8 fixed swatches) and its white tone (warm, neutral, cool), instead of only turning it on and off. Both go through the same remote security layer and the same house functions the `home_scene` and `home_control` tools use: the phone never talks to Home Assistant, stores nothing, and the approval mode "Solo lectura" still blocks it. A mode that holds a lock, an alarm, a siren or a gate is the exception to the one-tap rule: it is activatable only with the existing locks-and-alarms sub-switch on and a passkey step-up bound to that activation; otherwise it is shown disabled with the reason and the PC refuses it. No new switch, no new tool and no new risk class are added.

## 2. Problem and goal
Today the phone's Home tab lists the house's things by room and offers a toggle for lights, switches and fans plus the secure actions for locks, covers and alarms (`src/remote-client/lib/home.ts`, `thingActions`). A light can be turned on but not dimmed or colored, and a mode cannot be activated at all: the person must ask the chat agent, which starts a run and spends tokens for what is one button on the PC. The desktop (Casa tab, sidebar) and the Telegram `/home` panel both activate modes, and the desktop device panel sets brightness, white tone and color.

Facts the design respects (verified in code and specs):
- The remote `things()` returns only `id, entityId, name, kind, areaId, state, sensitive` per thing and the areas: no light attributes and no modes (`src/coordinator/channels/remote/home.ts`). `control()` accepts only `{thing, action[, assertion]}` (`homeControlBody`, `src/shared/remote/api.ts`) and builds the tool call from `target` and `action` alone, so brightness, color and temperature never reach `home_control`. No route exists for modes.
- The desktop already has the data: `hub.snapshot()` carries `scenes` (entity id and name) and, for lights, the attributes `brightness`, `color_mode`, `supported_color_modes`, `rgb_color`, `color_temp_kelvin`, `min_color_temp_kelvin`, `max_color_temp_kelvin` (`src/coordinator/home/model.ts`).
- `home_scene` has risk `home` (never asks; blocked only in the read-only approval mode: 013 BR-13, 014 AC-7.1, AC-7.4) and activates a mode by name or entity id. Its failure note when a mode is not found lists the names of all modes (`tool.home.noMode`).
- `home_control` (risk `home`) maps brightness (percent), color (one of ten Spanish names, or `rgb`) and temperature (`calida`, `neutra`, `fria` or kelvin) to `light/turn_on` (013 AC-5.1, AC-5.4). It does not bound `rgb` values or kelvin, and its `set` action on a light that is off turns it on.
- The desktop device panel shows, for a lit light: a brightness slider (1-100, only if the light reports brightness, sent on release), warm/neutral/cool buttons (2700/4000/6000 K, only with color temperature) and 8 color swatches (only with color modes) (013 AC-9.3, `DevicePanel.tsx`). The 8 swatches live only in the renderer (red = 255,40,40); the tool's 10 named colors have other values (rojo = 255,0,0).
- Scenes made with `home_modes` can store a lock or a gate, and `home_scene` activates them without asking; the Telegram `/home` panel activates any listed mode on one tap with no check either. This is Known limit #3 in `docs/modules/home.md`. From the phone it would let a paired phone move a lock or a gate without the locks-and-alarms sub-switch (026 AC-5.12) and without a passkey step-up (026 AC-5.13, AC-5.20). The owner decided to close it for the phone (BR-7) and leave the other surfaces as they are (BR-18).
- 026 limits: 60 requests per minute per device, 1 MB body, 30-second timeout (BR-31); a change to a limit is a spec change (028 BR-11).

Done means: with the home scope on and the house connected, the person can activate a mode and set a light's brightness, color and white tone from the phone, with every refusal explained by a concrete cause; a mode that moves a lock, alarm or gate cannot be activated by a phone that could not open that lock directly; with the home scope off, the phone revoked, the PC unreachable or the approval mode read-only, nothing runs and the phone says why; and nothing the desktop already does is duplicated in a second implementation.

## 3. Scope
**In:**
- Listing every mode the PC lists and activating one by its id, from a section at the top of the Home tab.
- The extra rule for a mode that holds a sensitive thing: sub-switch plus passkey step-up (BR-7).
- Light settings from the Home tab for a light that is on and reports the capability: brightness (slider, whole percent 1-100, sent on release), color (8 fixed swatches) and white tone (warm, neutral, cool).
- Returning to the phone, for lights, the attributes those controls need (and nothing else of Home Assistant's attributes).
- Moving the 8-swatch palette to `shared` so the desktop panel and the phone use one list.
- The narrow-API operations that serve them, inside the 026 security layer (authorization, session, limits, audit), and the route snapshot update.
- Audit of mode activations and light settings.
- States (loading, empty, error, scope off, PC unreachable, house off), the refresh control, and es/en text for the new Home content.
- Docs in the same PR as the implementation (§7.1).

**Out (and why):**
- Creating, editing or deleting modes from the phone: `home_modes` is `write` and stays a chat/desktop matter; the owner asked to activate.
- Settings of other kinds (fan speed, cover position, volume, climate setpoint), light effects and transitions, a free color picker, a kelvin slider, brightness steps, acting on several lights at once: not requested or not chosen; each is a later spec.
- Rules, automations, the floor plan and camera changes on the phone: unchanged from 026.
- Changing how the desktop, the agent tools or the Telegram panel treat modes that hold a sensitive thing (BR-18): Known limit #3 stays for those surfaces.
- A new scope, sub-switch, native confirmation or `ToolRisk` (BR-8, BR-2).
- An approval card for mode activation (risk `home` never asks): the passkey is the only confirmation for a sensitive mode (BR-7).
- A confirmation tap for ordinary modes, optimistic UI, a command queue, periodic polling, a sixth app destination (BR-16, BR-11).
- A mode, brightness or color the phone remembers (favorites, recents, last values): the phone stores nothing (026 BR-32).
- Any change to the 60-per-minute, 1 MB or 30-second limits (028 BR-11).
- The Alma-run relay, push notifications for modes, scheduling a mode from the phone.

## 4. Users and stories
- **US-1** As a person away from the PC, I want to activate a house mode ("Noche", "Me fui") from my phone with a tap, so that I change several devices at once without asking the chat agent or going to the PC.
- **US-2** As a person, I want to set the brightness of a light from my phone, so that I can dim it without the PC.
- **US-3** As a person, I want to set the color of a light that can show colors, and not be offered a color for one that cannot, so that the controls match what the bulb does.
- **US-4** As a person, I want to choose the white tone (warm, neutral, cool) of a light that supports it, so that the phone does what the desktop panel does.
- **US-5** As the owner, I want a mode that moves a lock, alarm or gate to need the same switch and the same passkey as opening that lock directly, and everything else to obey the same limits as the rest of the phone's house control (home scope, approval mode), so that a stolen or lost paired phone gets no more power than I decided.
- **US-6** As the owner or a reviewer, I want these actions on the record in the remote-activity list, by entity and outcome and never by content, so that I can tell what a phone changed in the house.
- **US-7** As the maintainer, I want the phone to reuse the house functions, capability rules and color palette the desktop already has, through the same narrow API and snapshot test, and the docs updated in the same PR, so that no second, weaker path to Home Assistant exists.
- **US-8** As a person, I want every new control to show a clear loading, empty, error, scope-off and unreachable state in my language, and to show the real state of the house after each action, so that it never looks frozen, blank or wrong.

## 5. Acceptance criteria
Tests name the id: `it('AC-1.1 …')`. At draft stage no test exists, so testable criteria carry `[gap]`. UI text is cited by dictionary key (spec 025); proposed keys are in §6.1.

### Modes: list (US-1, US-5, US-8)
- **AC-1.1** (US-1) Given the home scope on and the house connected, when a device asks for the modes, then it receives every mode the PC lists (BR-6), each with an id, a name and whether it holds a sensitive thing, in the order the desktop lists them (by name, in the locale of the app language), and the Home tab shows them in a section titled `remote.pwa.modes.title` at the top of the tab, above the rooms. [gap]
- **AC-1.2** (US-1, US-8) Given the house connected and no mode to list, when the Home tab loads, then the modes section shows `remote.pwa.modes.none` (what is missing and what to do) instead of a blank, and the rest of the Home tab still works. [gap]
- **AC-1.3** (US-5) Given the home scope off, when a device asks for the modes, then it is refused with the same answer as the other home operations, nothing is read from Home Assistant, and the phone shows `remote.pwa.scopeOff`. [gap]
- **AC-1.4** (US-8) Given the house turned off or not connected, when a device asks for the modes, then it receives the existing explanation (`tool.home.off` or `tool.home.notConnected`, 026 AC-5.10), never a blank, and the phone shows it. [gap]
- **AC-1.5** (US-5, US-7) Given a response with modes, then each carries only id, name and the sensitive flag; no entity list, attribute or configuration of the mode leaves the PC. A test lists the keys it can return. [gap]
- **AC-1.6** (US-5) Given a mode that holds a sensitive thing (BR-6), when the locks-and-alarms sub-switch is off, then the phone shows it in the list disabled with `remote.pwa.sensitiveOff` as the reason; when the sub-switch is on, it is shown enabled and marked `remote.pwa.mode.sensitive`. A mode whose entities the PC cannot read is flagged as sensitive (BR-6). [gap]

### Modes: activate (US-1, US-5, US-6)
- **AC-2.1** (US-1) Given the home scope on, the house connected and a mode that holds no sensitive thing, when a device asks to activate it by its id, then the PC activates that mode through the function `home_scene` uses (014 AC-7.1) with no approval card and no confirmation step, answers ok, and the phone shows `remote.pwa.mode.done` with the mode's name and rereads the house. "Done" means the PC's request to Home Assistant succeeded, not that every device obeyed. [gap]
- **AC-2.2** (US-1) Given a mode that no longer exists (deleted on the PC or in Home Assistant after the phone listed it), when a device asks to activate it, then nothing runs, the answer names no other mode, and the phone shows `remote.pwa.mode.gone` and reloads the list. [gap]
- **AC-2.3** (US-5) Given a mode that holds a sensitive thing and the locks-and-alarms sub-switch off, when a device asks to activate it, then it is refused with `remote.pwa.sensitiveOff` and nothing runs, even if the request carries a valid step-up assertion (026 AC-5.12). [gap]
- **AC-2.4** (US-5) Given such a mode and the sub-switch on, when a device asks to activate it without a valid step-up, then it is refused (`remote.pwa.stepUp.failed`) and nothing runs. A step-up is a WebAuthn passkey assertion the PC verifies, required on every activation, with no fallback, valid 60 seconds, single use and bound to that mode and that action: an assertion for another mode, another thing or action, one already used, or an expired one is refused. [gap]
- **AC-2.5** (US-5) Given such a mode, the sub-switch on and a valid step-up, when a device asks to activate it, then the PC activates it through the same function as AC-2.1; no approval card is shown (risk `home`, BR-2), so the passkey is the only confirmation; the activation requires the passkey in any direction, whatever state the mode sets (BR-6). [gap]
- **AC-2.6** (US-5) Given a mode that holds a sensitive thing, when the phone has no passkey, then the activation is not offered and, if requested anyway, is refused with `remote.pwa.stepUp.unsupported`; there is no fallback (026 AC-5.21). Given a step-up the person cancels or that fails on the phone, then the activation does not run and `remote.pwa.stepUp.failed` is shown (026 AC-5.14). [gap]
- **AC-2.7** (US-5) Given the PC decides a mode's sensitivity at each activation from the mode's current entities, when a mode that was listed as ordinary now holds a sensitive thing (it was edited after the phone listed it), then the activation is treated as AC-2.3 to AC-2.6 and never trusts the phone's earlier list or any flag in the request. [gap]
- **AC-2.8** (US-5) Given the approval mode "Solo lectura" (read-only), when a device asks to activate any mode, a sensitive one with a valid step-up included, then the call is refused with the existing note "Bloqueado por el modo de aprobación" and nothing runs (BR-3). [gap]
- **AC-2.9** (US-5) Given the home scope off, the house off or not connected, or an unknown or revoked device, when a device asks to activate a mode, then nothing runs and the answer is, respectively, the scope refusal, the existing explanation (026 AC-5.10) or the usual refusal (026 AC-5.3). [gap]
- **AC-2.10** (US-5) Given a body that does not match its schema (missing or non-string id, an id over the schema's maximum, extra keys), when handled, then it is rejected before any handler runs (026 AC-5.4). [gap]
- **AC-2.11** (US-8) Given the PC unreachable, a rate-limited device (60 per minute, 026 AC-10.1), a 30-second timeout or a failure of Home Assistant, when the device activates a mode, then the phone shows the concrete cause (`remote.pwa.pcUnreachable`, `remote.pwa.rateLimited` or the tool's failure note), the request is not stored or replayed later (BR-11), and nothing is shown as done. [gap]
- **AC-2.12** (US-7) Given the route table, then no route lets the phone create, edit, delete or read the definition of a mode, and the snapshot proves it (BR-9). [gap]
- **AC-2.13** (US-1, US-5) [manual] On a real phone with a real or demo house: activate an ordinary mode and see the lights change; a mode that holds a lock with the sub-switch off (disabled, reason shown) and on (passkey asked, then activated); with the home scope off, in read-only mode, with the house off, with the PC asleep and on a phone with no passkey. Checked after implementation.

### Light settings: brightness and color (US-2, US-3, US-5)
- **AC-3.1** (US-2, US-3, US-4) Given the home scope on and the house connected, when a device lists the things, then each light also carries only what the controls need: whether it reports brightness, color and color temperature (decided from the attributes of 013 AC-9.3) and its brightness in whole percent; no other Home Assistant attribute. Things that are not lights carry none of it. A test lists the keys it can return. [gap]
- **AC-3.2** (US-2, US-3, US-4, US-8) Given a light, when the Home tab draws it, then each setting control (brightness, color, white tone) is drawn only if the light is available, is on, and reports that capability, with no disabled placeholders for the others; a light that is off shows only its toggle, and an unavailable light shows no controls (013 AC-9.3, AC-9.4). [gap]
- **AC-3.3** (US-2) Given a light that is on and reports brightness, when a device sets brightness N in whole percent from 1 to 100, then the PC runs the function of `home_control` with the action `set` (013 AC-5.1), Home Assistant receives `light/turn_on` with `brightness_pct` N on that light, nothing asks (risk `home`), and the phone shows the state the PC reports afterwards. [gap]
- **AC-3.4** (US-3) Given a light that is on and reports color, when a device sets one of the 8 swatches of the shared palette (BR-15), then the PC runs the function of `home_control` with that swatch's color (013 AC-5.1, AC-5.4), Home Assistant receives `light/turn_on` with that rgb on that light, nothing asks, and the phone shows the state the PC reports afterwards. [gap]
- **AC-3.5** (US-3, US-5) Given a request for a setting the light does not report (a color on a light with no color mode, a brightness on a light that reports none, a white tone on one without color temperature), a request on a thing that is not a light, or a request on a sensitive thing, when handled, then it is refused as invalid by the PC, nothing runs, and the client's own check is never what protects it (BR-4, BR-5). [gap]
- **AC-3.6** (US-5) Given a setting for a light that is off, when handled, then the PC refuses it, Home Assistant receives nothing and the light does not turn on; the phone shows `remote.pwa.light.off` and rereads the house (BR-5). [gap]
- **AC-3.7** (US-5) Given a value outside the allowed range or shape (brightness outside 1-100 or not a whole number, a color that is not one of the 8 swatches, extra keys), when handled, then it is rejected before any handler runs and Home Assistant receives nothing (026 AC-5.4). [gap]
- **AC-3.8** (US-5) Given the approval mode "Solo lectura", when a device sets a light setting, then the call is refused with the existing note "Bloqueado por el modo de aprobación" (026 AC-5.18). [gap]
- **AC-3.9** (US-5) Given the home scope off, the house off or not connected, or an unknown or revoked device, when a device sets a light setting, then nothing runs and the answer is the scope refusal, the existing explanation (026 AC-5.10) or the usual refusal (026 AC-5.3). [gap]
- **AC-3.10** (US-8) Given a failure of Home Assistant or of the tool (offline bulb, timeout), when a device sets a light setting, then the phone shows the failure in the person's language, never a blank (026 AC-5.10), and the control returns to the state the PC reports. [gap]
- **AC-3.11** (US-2) Given the brightness slider, when the person drags it, then no request is sent while dragging; exactly one request is sent when the finger is released; and while a setting request for a light is in flight, no second setting request for that light is sent. The 60-per-minute limit is not changed (BR-10). A pure function decides the send, and a test covers a drag, a release and a release during an in-flight request. [gap]
- **AC-3.12** (US-2, US-3) [manual] On a real phone with a real or demo light: dim it, change its color, check a light that has no color, one that is off and one that is unavailable, and the same with the home scope off and in read-only mode. Checked after implementation.

### Light settings: white tone (US-4)
- **AC-4.1** (US-4) Given a light that is on and reports color temperature, when a device sets one of the three steps warm, neutral or cool, then the PC runs the function of `home_control` with that temperature (013 AC-5.1: 2700, 4000 or 6000 K as `color_temp_kelvin`), nothing asks, and the phone shows the state the PC reports afterwards. [gap]
- **AC-4.2** (US-4, US-5) Given any temperature other than the three steps (a number, an unknown name), when handled, then it is rejected before any handler runs; the NaN of 013 AC-5.16 never reaches Home Assistant from the phone. [gap]

### Audit and privacy (US-5, US-6)
- **AC-5.1** (US-6) Given a request to activate a mode or to set a light that reaches the PC, when handled, then exactly one audit entry is written through the existing `audit()` with `actor: 'remote'`, `detail.deviceId`, the entity id of the mode or the light, the action and the outcome, and no setting value (026 BR-30); a call that goes through a tool also leaves the tool's own entries (026 BR-13, AC-7.7). The modes list and the things list are not audited. [gap]
- **AC-5.2** (US-6) Given any audit entry written for these operations, then it carries identifiers and outcomes only: no mode name, no brightness, color or temperature value, no Home Assistant attributes, no secrets. A test feeds known strings through the new operations and scans the trail (026 AC-7.2). [gap]
- **AC-5.3** (US-6) Given a scope refusal, a failed authentication or a failed step-up on a new operation, then it is audited as in 026 AC-7.5 (`denied`, throttled one per minute, no names). Given the trail cannot be written, then the operation is not interrupted (026 AC-7.4). [gap]
- **AC-5.4** (US-5) Given any new response, then it carries `Cache-Control: no-store`, the service worker does not cache it, and the phone keeps no mode list and no light state in storage (026 BR-32, 028 BR-26). [gap]
- **AC-5.5** (US-5) Given a mode or a light setting, then the phone sends nothing to a host other than the PC and the PC sends nothing to a model provider or a new third party because of it (026 AC-9.1). [gap]
- **AC-5.6** (US-6) [manual] The remote-activity list on the PC (`remote.activity.title`) shows a mode activation and a light setting with the device name, when and what. Checked after a phone does both and a stranger is refused.

### States, freshness and look (US-8)
- **AC-6.1** (US-8) Given the new Home content (modes section, light controls), then each has exactly the states of 028 AC-6.3: loading, empty, error, scope off and PC unreachable, plus the house-off explanation; the pure mapping from every refusal and network outcome to a dictionary key covers the new operations and a new refusal without a key fails its test. `remote.pwa.retry` is offered only where trying again can help (028 AC-6.6). [gap]
- **AC-6.2** (US-8) Given every user-visible string of the new controls (swatch names for screen readers included), then it is a key of the PWA's dictionary in `es` and `en`, both present (028 AC-6.8), with no hard-coded text; the UI says "modo"/"mode", never "escena"/"scene" (`docs/context.md`, Mode). [gap]
- **AC-6.3** (US-8) Given the touch look, then the new controls follow `umbra-ui` adapted to touch (026 BR-17), use only components and tokens those skills already have (or extend them explicitly), meet the accessibility bar of 028 AC-6.12 (44 by 44 px targets, contrast, visible focus, labels, text that scales) and honor `prefers-reduced-motion`. [manual] Checked on an Android and an iPhone with a screen reader on.
- **AC-6.4** (US-8) Given a mode activation or a light setting, when the person triggers it, then the control shows a pending state until the PC answers and then shows the state the PC reports; it never shows the new value before the answer; on any failure it returns to the real state and shows the cause; and a request that could not reach the PC is not stored, queued or replayed. [gap]
- **AC-6.5** (US-8) Given the Home tab, then the house (things and modes) is read once on each visit and again after each action, a refresh control (`remote.pwa.refresh`) rereads it on demand, and no timer rereads it while the tab is open or idle. [gap]
- **AC-6.6** (US-8) Given the app, then it still has the five destinations of 028 AC-6.1; the modes live in the Home tab and no sixth destination is added. [manual]

### Docs and gates (US-7)
- **AC-7.1** (US-7) Given the route table (`ROUTES`), when the new operations are added or the existing control and challenge operations gain fields, then the snapshot test of 026 AC-3.6 is updated and fails if a route is added without it; every new or changed operation declares its scope, its audit class and a strict schema (028 AC-7.1). [gap]
- **AC-7.2** (US-7) Given the pure authorization function, when it runs for activating a mode, then it takes the home scope, the mode's sensitivity and the sub-switch into account and returns the same verdict through any transport (026 AC-3.2). [gap]
- **AC-7.3** (US-7) Given a mode activation or a light setting, then it runs through the same function as the `home_scene` / `home_control` tools and the same authorization (026 BR-13), never through a second mapping of brightness, color or temperature to Home Assistant services, and never a second decision of what is sensitive, inside `coordinator/channels` or the PWA; a test with a fake house shows the same service call the tool makes, and an architecture test shows no second path (Constitution IV). [gap]
- **AC-7.4** (US-7) Given the 8-swatch palette, then it lives once in `shared` and both the desktop device panel and the phone read it; a test fails if the two surfaces list different colors. [gap]
- **AC-7.5** (US-7) [manual] The same PR as the implementation updates the docs of §7.1 (`docs/modules/home.md` Known limits #3 and "From the phone", `docs/modules/remote-access.md`, `docs/security/`, `docs/context.md`). Checked by reading the PR diff against §7.

## 6. Business rules
Rules the code must obey. Rules marked (owner) are answers the owner gave on 2026-11-08; the others are an existing written rule applied, or a floor.

- **BR-1** (026 BR-2, BR-7; 028 BR-2) The new operations are part of the same remote channel: a closed list of operations, a strict schema each, session authentication and the pure authorization function. Network position never authenticates. The phone never talks to Home Assistant (026 AC-5.10).
- **BR-2** (026 BR-13, AC-5.10; owner Q6) The narrow API calls the same functions as `home_scene` and `home_control` and applies the same `ToolRisk` and approval policy as those tools: `home`, never asks, blocked only in read-only mode. This spec adds no agent tool, no new `ToolRisk` and no approval card for modes.
- **BR-3** (026 BR-13, AC-5.18; 013 BR-13, AC-5.12; owner Q3) The read-only approval mode blocks activating any mode, a sensitive one with a valid step-up included, and changing a light, from the phone.
- **BR-4** (013 BR-12, AC-6.1; 026 AC-5.10) Light settings apply to lights only. A sensitive thing is never controlled through the everyday control; light settings never reach one.
- **BR-5** (013 AC-9.3, AC-9.4; owner Q9, Q10) The phone offers a setting only for a light that is available, is on, and reports that capability (brightness; color mode; color temperature), with no disabled placeholders; a light that is off shows only its toggle. The PC decides capability and on/off from what the light reports at the moment of the request, never from the client, and refuses a setting on a light that is off instead of turning it on. Brightness is a whole percent from 1 to 100.
- **BR-6** (owner Q2, Q4) The phone is offered every mode the PC lists (the same set as the desktop sidebar and the Telegram panel). A mode holds a sensitive thing if any entity it sets is sensitive by 013 BR-12 (lock, alarm, siren, garage, gate or door cover), whatever state the mode sets; a mode whose entities the PC cannot read is treated as holding one. The PC decides this at each activation (AC-2.7).
- **BR-7** (owner Q3) A mode that holds a sensitive thing is shown to the phone but activated only under the rules of the locks-and-alarms sub-switch and the step-up. With the sub-switch off: shown disabled with `remote.pwa.sensitiveOff`, and the PC refuses it (026 AC-5.12). With the sub-switch on: a passkey step-up on every activation, in any direction (not only opening or disarming), valid 60 seconds, single use, bound to that mode and that action, no fallback (026 BR-24, AC-5.21). The passkey is the only confirmation: no approval card appears (BR-2). A mode that holds no sensitive thing needs neither.
- **BR-8** (owner Q1) Mode activation and light settings stay under the existing `home` scope. No new scope, sub-switch or native confirmation is added. The existing sub-switch now also covers sensitive modes, so its native confirmation and its text in the "Remote access" tab say that a phone can activate modes that move locks, alarms and gates.
- **BR-9** (026 BR-7; request) The phone activates modes; it does not create, edit, delete or read the definition of a mode (`home_modes` is `write` and has no phone route).
- **BR-10** (026 BR-31; 028 BR-11; owner Q11) The existing limits apply to the new operations (1 MB body, 60 requests per minute per device, 2 connections, 30-second timeout). A change to a limit is a spec change. A slider sends one request per gesture, when released, and at most one setting request is in flight per light.
- **BR-11** (026 BR-32; 028 BR-26; owner Q15) The phone keeps no mode list and no light state; responses are `no-store`; content lives only in memory while the screen is open. There is no optimistic UI: a control shows pending until the PC answers, then the state the PC reports. A request that could not reach the PC is never queued or replayed later.
- **BR-12** (026 BR-6, BR-30, BR-15; owner Q12) Audit: the existing `audit()` contract, `actor: 'remote'`, the device id in `detail.deviceId`; one `remote` entry per request that reached the PC, with entity id, action and outcome, and never a setting value, a name or content; secrets never appear in logs, audit entries, errors or fixtures.
- **BR-13** (026 BR-20; 028 BR-9, BR-10) UI text is by dictionary key in the PWA's es/en dictionary with a parity test. UI work loads the `console-ui` and `umbra-ui` skills at the plan and implement stages; the plan names the components and tokens used and invents none.
- **BR-14** (`docs/context.md`) The UI calls a scene a "modo" / "mode", never "escena" / "scene".
- **BR-15** (owner Q7, Q8, Q10) The controls and inputs are fixed: brightness a slider in whole percent 1-100 sent on release; color one of 8 fixed swatches (red, orange, yellow, green, lightblue, blue, violet, pink) from one palette in `shared` read by both the desktop panel and the phone; white tone three steps, warm 2700 K, neutral 4000 K, cool 6000 K. Nothing else is accepted from the phone.
- **BR-16** (owner Q13, Q14, Q16) Modes are a section at the top of the Home tab; no sixth destination (028 BR-36 stands). An ordinary mode activates on one tap with no confirmation step. The house is read on each visit and after each action, plus a refresh control; no periodic polling.
- **BR-17** (floor) A refusal or error note sent to the phone for a mode names no mode other than the one requested.
- **BR-18** (owner Q5) The sensitive-mode rule of BR-7 applies to the phone only. The desktop, the agent tools (`home_scene`) and the Telegram panel are unchanged; Known limit #3 stays for them and `docs/modules/home.md` says so.

### 6.1 UI text keys (proposed wording, initial; the dictionaries are the source once implemented)
Keys marked (reuse) exist; text marked (reword) exists and changes meaning slightly.

| Key | es (rioplatense) | en (US) |
|---|---|---|
| `remote.pwa.modes.title` | Modos | Modes |
| `remote.pwa.modes.none` | No hay modos. Pedile a Alma en el chat: «armame un modo Noche». | There are no modes. Ask Alma in the chat: "make me a Night mode". |
| `remote.pwa.mode.done` | Modo «{name}» activado. | Mode “{name}” is on. |
| `remote.pwa.mode.gone` | Ese modo ya no existe. | That mode no longer exists. |
| `remote.pwa.mode.sensitive` | Mueve cerraduras, alarmas o portones. | Moves locks, alarms or gates. |
| `remote.pwa.light.brightness` | Brillo | Brightness |
| `remote.pwa.light.color` | Color | Color |
| `remote.pwa.light.off` | La luz está apagada. | The light is off. |
| `remote.pwa.light.white.warm` / `.neutral` / `.cool` | Cálida / Neutra / Fría | Warm / Neutral / Cool |
| `remote.pwa.swatch.red` / `.orange` / `.yellow` / `.green` / `.lightblue` / `.blue` / `.violet` / `.pink` | Rojo / Naranja / Amarillo / Verde / Celeste / Azul / Violeta / Rosa | Red / Orange / Yellow / Green / Light blue / Blue / Violet / Pink |
| `remote.pwa.sensitiveOff`, `.stepUp.failed`, `.scopeOff`, `.rateLimited`, `.pcUnreachable`, `.retry`, `.refresh`, `.home.empty` (reuse) | existing | existing |
| `remote.pwa.stepUp.unsupported` (reword) | Este celular no tiene passkey: no puede abrir, desarmar ni activar modos que muevan cerraduras. | This phone has no passkey: it cannot open, disarm or activate modes that move locks. |

## 7. Constraints and risks
- **Layers touched** (see `docs/architecture.md`): `shared` (remote API schemas and `ROUTES`; the pure capability, range and sensitivity checks; the 8-swatch palette); `coordinator/channels/remote` (the home flow, the step-up flow and the route handlers; the house functions are reused, not copied); `src/remote-client` (Home screen, `lib/home.ts`, dictionaries); `renderer` only for the desktop device panel reading the palette from `shared`. `main` is untouched (no new setting or dialog; the existing sub-switch dialog text changes, BR-8: that string lives in the shared dictionaries).
- **Security / privacy:**
  - No new tool, no new secret, no new third party and no new stored personal data. Risk class `home` (BR-2).
  - What a stolen, unlocked, paired phone with the home scope on can do grows from toggling devices to activating any ordinary mode and setting lights. A mode can change many devices at once, but one that holds a lock, alarm, siren or gate needs the sub-switch (off at every turn-on, native confirmation) and a passkey on that phone, the same bar as opening that lock directly; read-only mode blocks everything (BR-3). Residual: unlike direct secure control (`publish`) there is no approval card, so the passkey is the only confirmation of a sensitive mode (owner decision, Q6). Other controls that exist: the home scope switch, the 15-day idle expiry, revoke, the tray kill switch, the audit trail.
  - A mode's sensitivity is decided by the PC at each activation, fail-closed when unreadable (BR-6, AC-2.7); the phone's list flag is only for display.
  - `things()` returns an allow-listed set of light attributes, not the raw attribute bag (AC-3.1); modes carry id, name and a flag only (AC-1.5).
  - `docs/security/RISKS.md` (the remote-access row) and `CONTROLS.md` are updated in the same PR (the step-up now also covers activating modes that move sensitive things; Known limit #3 closed for the phone only); `PRIVACY.md` is unchanged (no new data flow) and the PR says so.
- **Performance / platform:** `home_control` waits 700 ms before reporting state (013 AC-5.15); the slider sends on release so a drag cannot reach 60 requests per minute; Home Assistant scene activation has no resulting state to read back, so the phone rereads the house after it; names of modes are user-authored text of any length and characters.

### 7.1 Specs and docs to amend (explicit; applied in the same PR as the implementation, not in this draft)
026 and 028 are not edited by this draft. Every row is decided; a row marked "confirmed" keeps the old rule and is listed so the reader knows it was looked at.

| Spec / rule | Today | Under this spec | Decided by |
|---|---|---|---|
| 026 BR-7 | Closed list of operations includes "house list and control" | The list gains: list the modes, activate a mode by id; the house control operation carries light settings (brightness, color swatch, white tone); the list of things carries the light attributes of AC-3.1; the step-up challenge also names a mode; still no route that creates, edits, deletes or reads a mode | BR-1, BR-9, AC-7.1 |
| 026 AC-3.6 | Route snapshot test | Updated with the new or changed operations | AC-7.1 |
| 026 AC-5.10 | The narrow API lists and controls things with the tools' functions and risk; sensitive things never through the everyday control | Also lists modes and activates one with `home_scene`'s function, and sets light settings with `home_control`'s; risk `home`; sensitive rule confirmed | BR-2, BR-4 |
| 026 AC-5.12 | A lock, alarm, siren or gate is refused while the locks-and-alarms sub-switch is off | Also governs a mode that holds such a thing: listed disabled, refused by the PC | BR-6, BR-7, AC-1.6, AC-2.3 |
| 026 AC-5.13, AC-5.14, AC-5.21 | Step-up needed to open or disarm; failure or cancel runs nothing; no passkey means refused, no fallback; the approval card is a second confirmation | Extended to activating a mode that holds a sensitive thing; the second confirmation (approval card) is not applied to modes because the risk stays `home` | BR-7, AC-2.4 to AC-2.6 |
| 026 AC-5.20, BR-24 | Step-up only for unlock, open (gate, garage, door cover) and disarm; none for lock, close, arm, siren trigger/silence, cover stop/position | Unchanged for direct control. Activating a mode that holds any sensitive thing needs one in any direction (no direction exemption), bound to that mode and action | BR-6, BR-7 |
| 026 AC-5.18 | Read-only mode refuses "controls a house thing" | Also refuses activating a mode (sensitive ones included) and light settings | BR-3 |
| 026 AC-1.9, AC-1.10, BR-29; "Remote access" tab text | The sub-switch is "locks and alarms"; its native confirmation and hint describe locks and alarms | Wording only, no new dialog: they also say a phone can activate modes that move locks, alarms and gates | BR-8 |
| 026 BR-5, AC-1.12; glossary **Scope** | Scopes and sub-switches and their defaults | Confirmed: no new scope or sub-switch (home scope, locks sub-switch still off at every turn-on) | BR-8 |
| 026 BR-30, AC-7.1, AC-7.7 | Changes are audited; a phone-initiated tool call leaves two entries | Mode activations and light settings audited as changes, one `remote` entry per request, no value; two-entry rule confirmed | BR-12, AC-5.1 |
| 026 BR-31, AC-10.1 | 60 per minute, 1 MB, 30 s | Confirmed unchanged | BR-10 |
| 026 BR-32, AC-8.5 | The phone keeps no cache | Confirmed: modes and light state are not stored | BR-11 |
| 013 AC-5.1, AC-5.4, AC-9.3, BR-12, BR-13 | `home_control` mapping; the desktop panel's capability rules; sensitivity; risk classes | Reused as the source of the phone's mapping, capability rules and sensitivity (a second consumer); unchanged | BR-2, BR-5, BR-6 |
| 013 AC-9.3 (renderer `SWATCHES` in `DevicePanel.tsx`) | The 8 swatches are defined in the renderer | Same 8 colors, now read from `shared` by the panel and the phone | BR-15, AC-7.4 |
| 014 AC-7.1, AC-7.4, AC-7.5, BR-13; 010 Casa panel | `home_scene` activates any mode, risk `home`; modes as buttons on the PC; the Telegram panel activates any mode | Unchanged; the phone is a second surface with the extra rule of BR-7; Known limit #3 stays for the PC, the agent and Telegram | BR-18 |
| 028 AC-6.7, AC-6.11, BR-36, AC-6.1 | "What this phone can do" list and status keys; five destinations | Confirmed unchanged (no new switch, no new destination); no edit to 028 needed | BR-8, BR-16 |
| `docs/modules/home.md` Known limits #3, "From the phone", Tools table | #3: scenes can hold a lock and `home_scene` activates them unasked, a product decision | #3 reworded: closed for the paired phone (sub-switch + passkey), still open for the PC, the agent and Telegram; "From the phone" gains modes and light settings | BR-7, BR-18 |
| `docs/modules/remote-access.md`; `docs/security/RISKS.md` (remote-access row), `CONTROLS.md` | Describe what the home scope and the step-up reach | The step-up now also covers activating modes that move sensitive things; modes and light settings listed under the home scope; no approval card for modes stated plainly. `PRIVACY.md` unchanged | AC-7.5 |
| `docs/context.md` | **Mode**: "created and activated with `home_modes` / `home_scene`"; **Step-up** (remote): opening or disarming a sensitive device | **Mode** gains "also activated from a paired phone; one that holds a sensitive thing needs the sub-switch and a step-up"; **Step-up** gains that case. Deferred to the implementation PR | AC-7.5 |

## 8. Open Questions
All answered by the owner on 2026-11-08 and ticked; none remains, so the spec can go to the human for `ready`. Q2, Q3, Q7, Q8 and Q10 were answered one by one; the rest accepted the planner's recommended default as written. Each decision is written into §4-§6.

Settled by existing specs, not asked: that read-only mode refuses (BR-3); that the new operations enter the closed list, the strict per-operation schema and the route-snapshot test (026 BR-7, AC-3.6; 028 AC-7.1, here AC-7.1; whether the setting fields extend the existing control operation or get their own is a plan matter that must keep the schema strict); that limits stay (BR-10); that nothing is stored on the phone (BR-11); that changes are audited by identifier (BR-12).

### A. Gate and scope
- [x] Q1 Scope. Decision (owner, 2026-11-08): mode activation and light settings stay under the existing `home` scope; no new switch. (BR-8.)
- [x] Q2 Which modes the phone lists. Decision (owner, 2026-11-08, one by one): every mode the PC lists; the Q3 rule applies on top. (BR-6, AC-1.1.)

### B. Modes that move a lock, alarm or gate
- [x] Q3 Policy. Decision (owner, 2026-11-08, one by one): require a passkey step-up. Such a mode is activated from the phone only with the locks-and-alarms sub-switch on (026 AC-5.12) and a passkey step-up bound to that exact action (60 s, single use); without the sub-switch it is shown disabled with the reason and the PC refuses it; read-only mode still blocks. (BR-3, BR-7, AC-1.6, AC-2.3 to AC-2.8.)
- [x] Q4 How a mode counts as holding a sensitive thing. Decision (owner, 2026-11-08): any entity sensitive by 013 BR-12, whatever state the mode sets; a mode that cannot be read counts as sensitive. (BR-6, AC-2.7.)
- [x] Q5 Reach of the Q3 rule. Decision (owner, 2026-11-08): phone only; the PC, the agent tools and Telegram are unchanged. (BR-18.)

### C. Risk class
- [x] Q6 Risk of phone mode activation. Decision (owner, 2026-11-08): the tool's own, `home`, never asks, read-only blocks; no new `ToolRisk`, no approval card for modes. (BR-2, BR-3.)

### D. Light controls
- [x] Q7 Color temperature in scope. Decision (owner, 2026-11-08, one by one): yes. (US-4, AC-4.1, AC-4.2.)
- [x] Q8 Color input. Decision (owner, 2026-11-08, one by one): the 8 fixed swatches, with the palette moved to `shared` so the desktop and the phone share it. (BR-15, AC-3.4, AC-7.4.)
- [x] Q9 Controls that do not apply and the off-light rule. Decision (owner, 2026-11-08): show only the controls the light supports; an off light shows only its toggle; the PC refuses a setting on an off light. (BR-5, AC-3.2, AC-3.6.)
- [x] Q10 Brightness and temperature input. Decision (owner, 2026-11-08, one by one): brightness a slider in whole percent 1-100 sent on release; temperature the steps warm / neutral / cool (2700 / 4000 / 6000 K). (BR-15, AC-3.3, AC-3.11, AC-4.1.)

### E. Dragging, rate and audit
- [x] Q11 Slider behavior and rate. Decision (owner, 2026-11-08): one request per gesture on release; at most one setting request in flight per light; no limit change. (BR-10, AC-3.11.)
- [x] Q12 Audit of settings. Decision (owner, 2026-11-08): one `remote` entry per request that reached the PC (entity id, action, outcome, no value) plus the tool's own entries. (BR-12, AC-5.1, AC-5.2.)

### F. Experience and offline
- [x] Q13 Where modes live. Decision (owner, 2026-11-08): a section at the top of the Home tab; no sixth destination. (BR-16, AC-1.1, AC-6.6.)
- [x] Q14 Confirmation before activating a mode. Decision (owner, 2026-11-08): none, one tap; the only exception is the passkey for a sensitive mode (Q3). (BR-16, BR-7, AC-2.1.)
- [x] Q15 Offline, house off and optimistic UI. Decision (owner, 2026-11-08): no optimistic UI; a control shows pending until the PC answers, then the real state; on failure it returns to the real state with the cause; a request is never queued or replayed. (BR-11, AC-2.11, AC-6.4.)
- [x] Q16 Freshness of the Home screen. Decision (owner, 2026-11-08): read on each visit and after each action, plus a refresh control; no periodic polling. (BR-16, AC-6.5.)
