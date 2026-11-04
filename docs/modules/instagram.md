# Instagram

> Lets an agent publish a finished post (one image plus a caption) to the owner's Instagram account by driving a visible window on instagram.com, always after the owner approves it. Spec: [012 · Instagram](../../.specify/specs/012-instagram/spec.md). Test status: 9 criteria with a test, 14 manual-only, 13 without a test (36 in total).

## What it does

- **Connect once.** The person logs in on Instagram's real login page inside an Alma window. Alma never sees the password; it keeps only the session cookies.
- **Publish with approval.** The agent calls `instagram_publish` with an image and a caption. The person sees the exact image and caption on an approval card and presses "Publicar" (publish) or "Rechazar" (reject). This is asked every time, even in "Permitir todo" (allow all) mode.
- **Test mode (on by default).** Alma fills in the whole post in the Instagram window but does not press "Compartir" (share), so the person can check it by hand.
- **Visible failure.** If Instagram changes its page, the publish fails with a message and the window stays open so the person can finish the post by hand.
- **Daily routine.** A ready-made routine template, "Post diario de Instagram", has the default "Community Manager" agent prepare a post each working day.

Not implemented: reading Instagram (feed, messages, insights), stories, reels, carousels, several accounts.

## How to use it

The "bot in 4 steps" walkthrough, checked against the code:

1. «Configuración → Proveedores» (Settings → Providers): load the Anthropic key (for the text) and the xAI key (for the images). `compose_image` also works without an image-model key; see [images](images.md).
2. «Configuración → Instagram»: press "Conectar Instagram". A window "Conectar Instagram" (520×780) opens on Instagram's login page. Log in there; the window closes by itself about 1.2 s after the session cookie appears. The badge changes from "Sin conectar" (not connected) to "Conectada", and the button now reads «Abrir Instagram para revisar la sesión» (open Instagram to check the session). "Desconectar" clears the session.
3. In the working folder, create a `marca.md` with the tone, the audience, the topics and what to avoid. The routine prompt tells the agent to follow it and to avoid topics already listed in `publicaciones.md`.
4. «Rutinas → Plantilla: post diario de Instagram»: choose the folder and the time. The template is prefilled with agent `community-manager` (the default agent if that one was deleted), daily at 10:00 Monday to Friday. When the post is ready a desktop notification «Post listo para Instagram» arrives with the first line of the caption. Review the card and press «Publicar» or «Rechazar».

While «Modo de prueba» (test mode) is on, look at the Instagram window titled «Instagram · modo de prueba». If everything looks right, especially the line breaks of the text, turn test mode off in «Configuración → Instagram».

To ask in chat: «publicá en Instagram la imagen imagenes/promo.png con este texto: ...» (publish this image on Instagram with this text). The agent must have a working folder, because the image path has to be inside it.

Instagram may block actions or suspend accounts that automate. The tab recommends 1 or 2 posts a day; this is advice only, with no rate limit in code.

## How it works

| File | Role |
|---|---|
| `src/main/instagram.ts` | Session (partition `persist:instagram`), login window, `publishToInstagram` browser automation. |
| `src/main/index.ts` | Handlers for connect/disconnect/status and for the `instagram.publish` host request; audit entries; one-time import of the legacy "MultiAgente" profile. |
| `src/preload/index.ts`, `src/shared/desktop-api.ts` | `window.desktop.instagram.status|connect|disconnect` (IPC channels `instagram:status|connect|disconnect`). |
| `src/coordinator/tools/media.ts` | The `instagram_publish` tool, validation, approval preview. |
| `src/coordinator/index.ts` | Host bridge and the «Post listo para Instagram» notification. |
| `src/renderer/src/components/SettingsDialog.tsx` (`InstagramTab`), `ToolCard.tsx`, `RoutinesDialog.tsx` | Tab, post preview card, routine template. |

```
agent ── instagram_publish ──> approval card (image + caption) ── person approves
                                      │
coordinator: host.request {action:'instagram.publish', imagePath, caption, testMode}
                                      ▼
main: publishToInstagram -> visible 1180×900 window, driven with Chrome DevTools protocol
                                      ▼
host.result {ok, message} ──> tool result for the model
```

Non-obvious points:

- **Test mode is read when the tool runs**, from fresh settings, not when the approval was shown.
- **Automation steps.** Open the home page, click "Crear" (and «Publicación» if a menu appears), set the file on `input[type="file"]`, click "Siguiente" twice (crop, filters), insert the caption, then click "Compartir" and wait for a success text. Clicks are real mouse events at element positions, text goes in with `Input.insertText`, injected helpers only read the DOM.
- **"Compartir" is clicked once and never retried**, because a retry could publish twice. Other clicks are retried up to 3 times (each waits up to 6 s for the screen text to change).
- **Languages.** Page text is matched in English, Spanish and Portuguese. Other languages fail at the first step.
- **Disguise.** The user agent has the `Alma` and `Electron` tokens removed so the session looks like plain Chrome.
- **Stand-in page.** `ALMA_INSTAGRAM_URL` replaces `https://www.instagram.com` so the flow can be tested against a local page without touching an account.
- **"Connected"** means a non-empty `sessionid` cookie exists for the Instagram URL.
- Needs a display and the main window; it cannot run headless.

## Tools for agents

| Tool | `ToolRisk` | Asks approval | Purpose |
|---|---|---|---|
| `instagram_publish` | `publish` | Always, in every mode except `blocked` (which forbids it); "Siempre permitir" is never offered; a company agent goes through the boss first | Publish one `.png`, `.jpg` or `.jpeg` image from the working folder with a caption. Not `standalone`: needs a working folder. |

Registered in `BUILTIN_TOOLS`; held by the `community-manager` agent and by marketing agents in the company templates (`src/shared/company.ts`). The per-agent «Sin pedir aprobación» list in Settings → Agentes does not offer it.

Errors the model can see: «No existe la imagen …», «Instagram necesita una imagen PNG o JPEG.», «Instagram admite hasta 30 hashtags; el texto tiene N.», «La ruta … está fuera de la carpeta de trabajo.», «No hay una sesión de Instagram. Conectala en Configuración → Instagram.», and on automation failure «No pude <step>: <reason>. La ventana de Instagram quedó abierta para que termines a mano. Instagram puede haber cambiado su página.». A rejection returns «No se ejecutó: …» with the instruction not to retry the same action.

## Settings and data

| Setting | Default |
|---|---|
| `instagram.testMode` | `true` (settings saved by older versions get this default) |

Data: session cookies in the Electron partition `persist:instagram` under the user data folder; `settings.json` holds `testMode`. Alma stores no post history. `publicaciones.md` in the working folder is only a convention in the agent's prompt.

## Limits and rules

| Value | Source |
|---|---|
| One image, `.png` / `.jpg` / `.jpeg`; caption at most 2200 characters; at most 30 hashtags (`#` + letters, digits or `_`) | `tools/media.ts` (`CAPTION_LIMIT = 2200`) |
| Preview image only if at most 12 MB and PNG, JPEG or WebP; otherwise the approval shows the caption without image | `tools/media.ts` |
| Waits: page 30 s, "Crear" 30 s, «Publicación» 5 s, file input 20 s, each "Siguiente" 30 s, caption box 20 s, "Compartir" 20 s to be stable, success text 180 s, polling 500 ms | `main/instagram.ts` |
| Login window polls the cookie every 1.5 s and closes 1.2 s after it appears | `main/instagram.ts` |
| After a real publish the window closes 2.5 s later; in test mode and on failure it stays open | `main/instagram.ts` |
| The coordinator has no timeout on the host reply (longest step is the 180 s confirmation) | spec 012 §7 |

## Security and privacy

- Acts in the person's name on a third party (Instagram, Meta). The image and caption leave the machine only when publishing.
- Password never handled by Alma. Cookies sit in a separate Electron partition; the window runs sandboxed (`contextIsolation`, `sandbox`, no Node).
- Connect and disconnect from the UI are audited as `instagram.connect` / `instagram.disconnect` (actor `user`); a publish as `instagram.publish` (actor `agent`). No caption or image content goes into the audit.
- Listed in `../security/PRIVACY.md` under always-approved publications. See [security](security.md) and [approvals](approvals.md).
- A routine that publishes while nobody is at the computer simply waits for the person's approval.

## How it is tested

`tests/media.test.ts`: "previews the post and hands it to the host", "rejects missing images, unsupported formats and too many hashtags", "reports the host failure to the model". `tests/agent.test.ts`: "always asks before publishing, even when everything else is allowed" and "blocks publishing in read-only mode". The browser automation, the session code, the audit entries and the routine template have no automated test. By hand: connect with a real account, run a publish with test mode on and read the window, run against a stand-in page (`ALMA_INSTAGRAM_URL`) missing the "Crear" button to see the controlled failure, and trigger a publish with the window unfocused to see the notification.

## Known limits

1. **A bad image is only rejected after the person approved** (the preview just omits the image).
2. **"Compartir" clicked but no confirmation returns failure, though the post may be live.** The agent may report failure or retry. Needs a "maybe published" state. Product decision.
3. **Test mode returns `ok: true`**, so a routine may log the post as published in `publicaciones.md`.
4. The connect promise has no timeout.
5. Nothing prevents two publish windows at once on the same session.
6. Disconnecting does not close a publish window already open.
7. The posting advice (1 or 2 a day) is not enforced anywhere.

## See also

[Images](images.md) (creating the picture) · [Routines](routines.md) · [Approvals](approvals.md) · [Agents](agents.md) · [Companies](companies.md) · [Security](security.md) · [Tools](../references/tools.md) · [Architecture](../architecture.md)
