---
status: implemented
---

# 012 — Instagram

## 1. Summary
A person connects their own Instagram account once, by logging in on Instagram's real login page inside an Alma window. After that, an agent (by default the "Community Manager") can publish a finished post (one PNG or JPEG image plus a caption) through the Instagram website, driving a visible window. Every post is shown to the person first, with the image and the caption, and nothing is published without their approval. A "test mode", on by default, fills in the whole post but does not press "Compartir", so the person can check it by hand.

## 2. Problem and goal
Instagram has no public posting API for a personal desktop tool, and handing a password to an app is unsafe. Goal: an agent can prepare and publish posts for the person's account without Alma ever seeing the password, with the person approving each post, and with a controlled, visible failure (not a silent one) when Instagram changes its page.

## 3. Scope
**In:**
- Connecting, checking and disconnecting the Instagram session (Settings → Instagram, `window.desktop.instagram.*`).
- The `instagram_publish` tool: inputs, validation, approval preview, test mode, result messages.
- The browser automation in the main process (`publishToInstagram`) and its failure behavior.
- The host request path coordinator → main (`instagram.publish`).
- The Instagram settings tab and the "Post diario de Instagram" routine template.

**Out (and why):**
- How approvals work in general, "allow all", the boss review of companies: `../004-approvals/spec.md` and `../007-companies/spec.md`. This spec only states what is special for `instagram_publish`.
- Creating the image (`generate_image`, `compose_image`): `../020-images/spec.md`.
- Routines scheduling and reminders: `../018-routines-and-reminders/spec.md`.
- The default agent profiles in general: `../003-agents/spec.md`.
- Reading Instagram (feed, messages, insights), stories, reels, carousels, multiple accounts: not implemented.

## 4. Users and stories
- **US-1** As a person using Alma, I want to log in to Instagram in a window of the app and see whether I am connected, so that agents can post for me without ever having my password.
- **US-2** As a person using Alma, I want to disconnect Instagram, so that no agent can post any more.
- **US-3** As a person using Alma, I want to see the exact image and caption before each post goes out and to approve or reject it, so that nothing is published by surprise.
- **US-4** As a person using Alma, I want a test mode that fills the post but does not share it, so that I can trust the automation before letting it publish.
- **US-5** As a person using Alma, I want a clear failure that leaves the Instagram window open when Instagram's page changes, so that I can finish the post by hand.
- **US-6** As an agent, I want `instagram_publish` to reject a bad post (missing file, wrong format, too many hashtags) with a clear message, so that I can fix it before anything reaches Instagram.
- **US-7** As a person using Alma, I want a ready-made routine "Post diario de Instagram", so that an agent prepares a post every working day and asks me to approve it.
- **US-8** As the maintainer, I want the login/automation labels in several languages and a way to point it at a stand-in page, so that the flow can be tested without touching Instagram.

## 5. Acceptance criteria

### Session (US-1, US-2)
- **AC-1.1** (US-1) Given no stored Instagram cookies, when the Instagram tab opens, then it shows the badge "Sin conectar" and a "Conectar Instagram" button. [manual] Check in Configuración → Instagram with a fresh profile.
- **AC-1.2** (US-1) Given the person presses "Conectar Instagram", when the login window ("Conectar Instagram", 520×780, child of the main window) opens on `/accounts/login/`, then the person types credentials on Instagram's own page and the window closes by itself about 1.2 s after a non-empty `sessionid` cookie appears (checked every 1.5 s). [manual] Log in with a real account.
- **AC-1.3** (US-1) Given the person closes the login window before logging in, when it closes, then the connect call resolves with the current status (`connected: false`) and nothing is stored. [manual] Close the window right after it opens.
- **AC-1.4** (US-1) Given a session exists, when the tab opens, then the badge reads "Conectada" and the connect button reads "Abrir Instagram para revisar la sesión". [manual]
- **AC-2.1** (US-2) Given a session exists, when the person presses "Desconectar", then all storage of the `persist:instagram` partition is cleared and the status becomes not connected. [manual] Disconnect, reopen the tab: "Sin conectar".
- **AC-2.2** (US-1, US-2) Given connect or disconnect is invoked from the UI, when the main process handles it, then an audit event `instagram.connect` / `instagram.disconnect` with actor `user` is written. [gap]
- **AC-2.3** (US-1) Given the status is requested, when the `sessionid` cookie for the Instagram URL is missing or empty, then `connected` is false; otherwise true. [gap]

### The tool and its validation (US-6)
- **AC-6.1** (US-6) Given an existing PNG in the workspace and a caption, when `instagram_publish` runs, then it sends one host request `{ action: 'instagram.publish', imagePath: <absolute path>, caption, testMode: <setting> }` and returns the host's message. Test: tests/media.test.ts › "previews the post and hands it to the host"
- **AC-6.2** (US-6) Given the image does not exist, when the tool runs, then it fails with "No existe la imagen …" and sends no host request. Test: tests/media.test.ts › "rejects missing images, unsupported formats and too many hashtags"
- **AC-6.3** (US-6) Given the file extension is not `.png`, `.jpg` or `.jpeg` (case-insensitive), when the tool runs, then it fails with "Instagram necesita una imagen PNG o JPEG." and sends no host request. Test: tests/media.test.ts › "rejects missing images, unsupported formats and too many hashtags"
- **AC-6.4** (US-6) Given the caption has more than 30 hashtags (counted as `#` followed by letters, digits or `_`), when the tool runs, then it fails with "Instagram admite hasta 30 hashtags; el texto tiene N." and sends no host request. Test: tests/media.test.ts › "rejects missing images, unsupported formats and too many hashtags"
- **AC-6.5** (US-6) Given a caption longer than 2200 characters, when the call is validated, then the input is rejected as invalid before anything runs. [gap]
- **AC-6.6** (US-6) Given the host answers `ok: false`, when the tool runs, then it throws the host's message as a tool error, which the model sees. Test: tests/media.test.ts › "reports the host failure to the model"
- **AC-6.7** (US-6) Given an `image_path` outside the workspace (`..`, other drive, symlink out), when the tool runs, then it fails with "La ruta … está fuera de la carpeta de trabajo." [gap]
- **AC-6.8** (US-6) Given the conversation has no working folder, when the agent calls `instagram_publish`, then the call fails with "No hay carpeta de trabajo seleccionada…" before any approval is asked (the tool is not standalone). [gap]

### Approval and preview (US-3)
- **AC-3.1** (US-3) Given the preview is built for a post whose image exists, when the approval is shown, then it carries the image as a `data:image/png;base64,…` URL and the caption. Test: tests/media.test.ts › "previews the post and hands it to the host"
- **AC-3.2** (US-3) Given test mode is on, when the preview is built, then it carries the note "Modo de prueba activo: se completa todo menos el clic en «Compartir»."; with test mode off there is no note. Test: tests/media.test.ts › "previews the post and hands it to the host"; the off case is [gap].
- **AC-3.3** (US-3) Given approval mode "allow all" and `instagram_publish` in the "always allow" list, when an agent calls the tool, then the person is still asked, the approval does not offer "Siempre permitir" (`allowAlways: false`), and answering "always" is not remembered. Test: tests/agent.test.ts › "always asks before publishing, even when everything else is allowed"
- **AC-3.4** (US-3) Given approval mode "solo lectura" (`blocked`), when an agent calls the tool, then it is denied without asking and no post is made. Test: tests/agent.test.ts › "blocks publishing in read-only mode"
- **AC-3.5** (US-3) Given the person rejects the approval or cancels the run, when the tool call resolves, then nothing is sent to the host and the model gets "No se ejecutó: Rechazado por vos …" / "Cancelado" with the instruction not to retry the same action. [gap]
- **AC-3.6** (US-3) Given the approval card of `instagram_publish`, when it is shown in the chat, then the image and caption are displayed in a post preview and the confirm button reads "Publicar" (other tools read "Permitir"). [manual] Trigger a publish with the community manager and look at the card.
- **AC-3.7** (US-3) Given an approval for `instagram_publish` is requested, when it is raised, then a desktop notification "Post listo para Instagram" is posted whose body is the first line of the caption (or the thread title if empty). [manual] Trigger a publish with the window unfocused.
- **AC-3.8** (US-3) Given the image is missing, unreadable, not PNG/JPEG/WebP or larger than 12 MB, when the preview is built, then the approval still appears with the caption but without an image. [gap]
- **AC-3.9** (US-3) Given an agent of a company, when it calls `instagram_publish`, then its boss reviews first; a boss "flag" rejects it with the boss's reason, otherwise the person is asked (no "always" option). See `../007-companies/spec.md`. [gap]

### Publishing in the window (US-4, US-5)
- **AC-4.1** (US-4) Given no Instagram session, when the publish request reaches the main process, then it answers `ok: false` "No hay una sesión de Instagram. Conectala en Configuración → Instagram." and opens no window. [gap]
- **AC-4.2** (US-4) Given a session and test mode on, when the publish runs, then a visible 1180×900 window "Instagram · modo de prueba" opens the home page, clicks "Crear" (and "Publicación" if a menu appears), uploads the image into the file input, clicks "Siguiente" twice (crop, filters), types the caption, and stops without clicking "Compartir", answering `ok: true` with the "Modo de prueba: dejé el post completo…" message; the window stays open. [manual] Run with a real account and test mode on.
- **AC-4.3** (US-4) Given a session and test mode off, when the publish runs, then after the same steps it clicks "Compartir" exactly once, waits up to 180 s for a success text (en/es/pt, e.g. "se compartió tu publicación"), answers `ok: true` "Publicado en Instagram." and closes the window 2.5 s later. [manual] Run with a real account and test mode off.
- **AC-4.4** (US-5) Given a step fails (an element is not found within its timeout, a click does not advance after 3 attempts, the window is closed by the person), when the failure is caught, then the result is `ok: false` with "No pude <step>: <reason>. La ventana de Instagram quedó abierta para que termines a mano. Instagram puede haber cambiado su página." (without the "ventana quedó abierta" sentence if the window was closed), and the window is not closed. [manual] Run against a stand-in page (`ALMA_INSTAGRAM_URL`) missing the "Crear" button.
- **AC-5.1** (US-5) Given the click on "Compartir" was made but the confirmation text never appears within 180 s, when the wait ends, then the failure message is "No pude confirmar que se publicó: no apareció la confirmación de Instagram…" and the window stays open, and the post is not retried. [manual]
- **AC-5.2** (US-5) Given the main process throws while publishing, when the host reply is built, then the coordinator receives `ok: false` with the error message instead of hanging. [gap]
- **AC-5.3** (US-4) Given a publish finishes (ok or not), when the agent run ends, then an audit event `instagram.publish` with actor `agent` and outcome `ok` / `error` was written. [gap]

### Settings, routine and defaults (US-4, US-7)
- **AC-7.1** (US-4) Given default settings, when read, then `instagram.testMode` is true; settings saved by older versions without the section get the default. [gap]
- **AC-7.2** (US-4) Given the "Modo de prueba" checkbox, when the person toggles it, then `instagram.testMode` is saved and the next publish request carries that value. [manual] Toggle, publish, check the window title.
- **AC-7.3** (US-7) Given the routines dialog, when the person picks "Plantilla: post diario de Instagram", then a routine "Post diario de Instagram" is prefilled: agent `community-manager` (or the default agent if it was deleted), daily at 10:00 Monday to Friday, with a prompt that follows `marca.md`, avoids topics in `publicaciones.md`, generates the image, writes the text, publishes and records it. [manual] Open Rutinas and use the template.
- **AC-7.4** (US-7) Given a routine publishes while nobody is at the computer, when `instagram_publish` is called, then it waits for the person's approval like any other call. [gap]
- **AC-7.5** (US-3) Given the per-agent "Sin pedir aprobación" list in Settings → Agentes, when it is shown, then `instagram_publish` is not offered there and the legend says that publishing on Instagram always asks. [manual]

## 6. Business rules
- **BR-1** `instagram_publish` has `ToolRisk` `publish`: it always asks the person, whatever the approval mode, "always allow" rules or per-agent auto-approve list; only "solo lectura" blocks it. "Siempre permitir" is never offered. (src/coordinator/approval.ts, src/coordinator/tools/media.ts)
- **BR-2** A post is exactly one image (`.png`, `.jpg`, `.jpeg`) and a caption of at most 2200 characters with at most 30 hashtags. (src/coordinator/tools/media.ts)
- **BR-3** Test mode is a setting, default on. When on, the automation never clicks "Compartir". The value is read when the tool runs (fresh settings), not when the approval was shown. (src/shared/defaults.ts, src/coordinator/tools/media.ts, src/coordinator/agent.ts)
- **BR-4** The password is never handled by Alma: the person types it on Instagram's page. Alma keeps only the session cookies, in the separate Electron partition `persist:instagram`. (src/main/instagram.ts)
- **BR-5** "Connected" means a non-empty `sessionid` cookie exists for the Instagram URL. (src/main/instagram.ts)
- **BR-6** "Compartir" is clicked once and never retried, because a retry could publish twice. Other clicks are retried up to 3 times (each waits up to 6 s for the screen text to change). (src/main/instagram.ts)
- **BR-7** Waits: page loaded 30 s; "Crear" 30 s; "Publicación" menu option 5 s; file input 20 s; each "Siguiente" 30 s; caption box 20 s; "Compartir" 20 s to be stable (position changes < 2 px between two reads 300 ms apart); success confirmation 180 s; polling every 500 ms. (src/main/instagram.ts)
- **BR-8** On failure the window is left open and the message names the failed step, the reason and a hint that Instagram may have changed its page. On a successful real publish the window closes after 2.5 s; in test mode it stays open. (src/main/instagram.ts)
- **BR-9** Page text is matched in English, Spanish and Portuguese, always including the app language's labels (spec 025 BR-24) (labels for Create, Post, Next, Share, dismissing pop-ups such as "Not Now"/"Ahora no", and success texts). Other languages fail at the first step. (src/main/instagram.ts)
- **BR-10** The page is driven with the Chrome DevTools protocol (debugger attached to the window): clicks are real mouse events at element positions, text is inserted with `Input.insertText`, the file is set on the page's `input[type="file"]`. Injected helpers only read the DOM. (src/main/instagram.ts)
- **BR-11** The session presents as plain Chrome: the user agent has the `Alma` and `Electron` tokens removed. (src/main/instagram.ts)
- **BR-12** The Instagram base URL is `https://www.instagram.com` unless the environment variable `ALMA_INSTAGRAM_URL` overrides it (intended only for tests against a local stand-in page). (src/main/instagram.ts)
- **BR-13** The approval preview reads the image as a data URL only if it is at most 12 MB and PNG, JPEG or WebP; otherwise the approval is shown without image. (src/coordinator/tools/media.ts)
- **BR-14** Connect and disconnect from the UI are audited with actor `user`; a publish with actor `agent`. No caption or image content goes into the audit. (src/main/index.ts)
- **BR-15** The Instagram session is carried over once from the legacy "MultiAgente" profile folder when the new profile has no `settings.json`. (src/main/index.ts)
- **BR-16** The settings tab warns that Instagram may block or suspend accounts that automate, and recommends 1 or 2 posts a day. This is advice only; there is no rate limit in code. (src/renderer/src/components/SettingsDialog.tsx)

## 7. Constraints and risks
- **Layers touched:** `main` (`src/main/instagram.ts`, handlers in `src/main/index.ts`), `preload` (`src/preload/index.ts`, `src/shared/desktop-api.ts`: `instagram.status|connect|disconnect`, IPC channels `instagram:status|connect|disconnect`), `coordinator` (`src/coordinator/tools/media.ts` tool; `src/coordinator/index.ts` host bridge and the "Post listo para Instagram" notification), `shared` (`Settings.instagram.testMode`, `InstagramStatus`, `HostRequest`), `renderer` (`SettingsDialog.tsx` InstagramTab, `ToolCard.tsx` post preview, `RoutinesDialog.tsx` template).
- **Host request path:** the coordinator calls `host.request({ action: 'instagram.publish', imagePath, caption, testMode })`; it sends `{ type: 'host.request', reqId, request }` to main, main runs `publishToInstagram` and replies `{ type: 'host.result', reqId, ok, message }`. A thrown error becomes `ok: false` with its message. The coordinator has no timeout on this wait; the longest step is the 180 s confirmation.
- **Tools and risk:** `instagram_publish` — `ToolRisk` `publish`, not standalone (needs a working folder). Registered in `BUILTIN_TOOLS`; held by the default agent `community-manager` and by marketing agents in the company templates (`src/shared/company.ts`), where the boss reviews first.
- **Persistence:** session cookies in the Electron partition `persist:instagram` under the user data folder; `settings.json` holds `instagram.testMode`. No post history is stored by Alma; the agent's own `publicaciones.md` in the workspace is a convention of its prompt.
- **Security/privacy:** acts in the person's name on a third party; third party is Instagram (Meta). The caption and image leave the machine on publish only. The window uses a sandboxed renderer (`contextIsolation`, `sandbox`, no Node). Listed in `docs/security/PRIVACY.md` ("Publicaciones, siempre con aprobación").
- **Fragility:** the automation depends on Instagram's page structure and text; it can break at any time. By design it fails visibly (BR-8).
- **Platform:** needs a display and a main window; cannot run headless. Windows paths are passed as absolute paths.
