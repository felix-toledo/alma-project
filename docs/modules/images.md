# Images

> Making pictures (an image model, or Alma's own composition library with no model at all) and understanding pictures you send (vision). Spec: [020](../../.specify/specs/020-images/spec.md); the choice of the creating and seeing models is [038](../../.specify/specs/038-image-models-create-and-see/spec.md). Test status: about 19 criteria with a test, about 42 without (composition is well covered; generation providers, vision and the inbox are mostly not).

## What it does

**For the person.**

- Agents can **generate** an image from a description with xAI (default), OpenAI or Meta.
- Agents can **compose** an original, on-brand image (quote, announcement, promo, list, tip, event…) from Alma's built-in library and from your own brand pieces in a `biblioteca/` folder. No image model or image key is needed, so it works with Claude or DeepSeek too. You get an editable SVG and a PNG.
- You can **paste, drop or send by Telegram** a picture, and an agent can look at it and answer questions about it.
- Generated and composed images appear inside the tool card in the chat.

**For an agent.** `generate_image`, `compose_image` and `look_at_image`. Agents never keep images in their conversation: they get a file path, and to see a picture they call `look_at_image`, which returns text.

## How to use it

**Choose the image service.** «Configuración → Imágenes»: pick the service (xAI, OpenAI, Meta). A service shows «· falta la key» (key missing) when it has neither a stored key nor an environment key; keys are set in «Configuración → Proveedores». The model field may stay empty («vacío = el más nuevo disponible», empty = newest available); the refresh button lists the service's image models. Changing the service clears the model. If you paste something that looks like an API key into the model field, Save is disabled («Eso es una API key, no un modelo…»).

**Choose what looks at pictures.** The same tab has a second card, «Visión de imágenes» (spec 038), under the one that creates. It sets the provider and model that read pictures for `look_at_image`, `camera_look`, camera watches, plan-from-photo and the pictures attached in the chat; it used to be a pair of fields in «Configuración → Casa», which now shows only a read-only line and a button that opens this tab. The dropdown offers «Automático» and the five chat providers (Meta, Anthropic, xAI, DeepSeek, Vercel AI Gateway), each marked «· falta la key» without a stored or environment key. OpenAI is not offered (Alma has no chat client for it). Changing the provider clears the model. With a provider and an empty model a line says either that Alma will look for the newest model of that provider that can see (Anthropic, xAI, Meta) or that Alma knows no model of that provider that can see and one must be typed (DeepSeek, Vercel). With «Automático» the card shows which provider and model the agent chain would use now. Picking a provider the person has not acknowledged opens a confirmation that names it; Confirm saves the provider, an empty model and the acknowledgement in one update, Cancel changes nothing. For DeepSeek and Vercel the dialog also asks for a model and Confirm stays disabled until one is typed, so a look never ends up with a provider and nothing to ask. A provider saved without being acknowledged (a value carried over from Casa) shows a line saying which model is used instead and a «Confirmar <provider>» button that opens the same dialog. The card also repeats the cost note about camera watches.

**Ask for pictures.** Real phrases:

- «Generá una imagen de un mate sobre una mesa de madera, formato 4:5» (generate an image of a mate on a wooden table).
- «Armame un post de cita con esta frase: …» (make me a quote post with this phrase).
- «Hacé una imagen de promo con la paleta de mi marca» (make a promo image with my brand palette).

**Your brand library.** Create `biblioteca/` inside the working folder:

```
biblioteca/
  logo.svg        placed alone in a corner (also .png .jpg .webp)
  flor.svg        any SVG or image, used by name ("flor") as an element, or as a background with `photo`
  MiFuente.ttf    fonts .ttf .otf .woff .woff2, used by file name ("mifuente")
  paletas.json    {"marca": {"background": "#14213d", "background2": "#1f3a6e", "text": "#ffffff", "accents": ["#fca311"]}}
  recetas.json    ready-made combos (template, palette, font, background, pieces)
```

A recipe is called with `recipe: "promo"`; whatever else the agent passes overrides it and its `elements` add to the recipe's. `"decorations": false` drops the template's own shapes. If you have your own palettes and none is named, one of yours is used. Your SVG pieces take the element's `color` where they use `currentColor` and `color2` where they use `var(--acento)`. A piece named like a built-in shape wins. Details and an example recipe are in the README section «Biblioteca de imágenes».

**Show Alma a picture.** Paste a screenshot into the chat box or drop an image on the chat; it shows as an attachment chip and the next message carries "Imagen adjunta (mirala con look_at_image): <path>" (attached image, look at it with look_at_image). Through Telegram, send a photo; the agent gets «[El usuario te mandó una imagen: <path>. Mirala con look_at_image.]» plus the caption.

## How it works

| File | Role |
|---|---|
| `src/coordinator/tools/media.ts` | `generate_image`, `compose_image` (also contains `instagram_publish`, see [instagram](instagram.md)) |
| `src/coordinator/images.ts` | MIME sniffing, listing image models (`createCandidates`) and picking one (`pickImageModel`), generation |
| `src/shared/images/models.ts` | The capability table (`SEE_RULES`, one entry per provider), the create patterns, `canCreate`, `canSee`, `hasSeeRule`, `newestModel`, `pickImageModel`, `pickSeeModel`, `createCandidates`, `seeCandidates`, `CREATE_PROVIDERS`, `SEE_PROVIDERS` (pure) |
| `src/shared/images/vision.ts` | `resolveVision` (the acknowledgement gate and the agent chain), `sanitizeImagesSettings`, `acceptImagesPatch`, `migrateLegacyVision`, `omitLegacyVision` (pure) |
| `src/shared/attach/readers.ts` | `pickVisionModel` and `threadReaders` (built on `resolveVision`, no network), `planSeeProvider` (ask or not, and the one patch to save) |
| `src/coordinator/compose/index.ts`, `library.ts` | the composition engine and the `biblioteca/` loader |
| `src/coordinator/vision.ts` | `look`, `loadPicture`, `visionModel` (async: completes a provider with no model by listing, with a per-process cache), `imageSize` |
| `src/coordinator/tools/home.ts` | `look_at_image` tool definition |
| `src/coordinator/index.ts` | `saveInboxImage` (Telegram photos), `files.image`, `images.models` requests |
| `src/coordinator/channels/telegram.ts` | photo download into the inbox |
| `src/main/render.ts` | SVG to PNG in a hidden window |
| `src/renderer/src/components/ToolCard.tsx`, `WorkspaceImage.tsx`, `SettingsDialog.tsx` | card image, preview, Images tab (`CreateGroup`, `SeeGroup`, `SeeModel`) |
| `src/renderer/src/components/AttachDialogs.tsx` | `SeeProviderDialog`, the confirmation of a see provider |
| `src/main/settings.ts` | load: `sanitizeImagesSettings` and the one-time move of the old Casa fields; update: `acceptImagesPatch` |

**Generate.** Model = `settings.images.model` if set; otherwise the newest matching model of the service (`canCreate` in `src/shared/images/models.ts`: ids matching `image|imagine` for xAI, `gpt-image*`/`dall-e*` for OpenAI, `muse-image*` for Meta, and for every service not containing `video` or `edit`; numeric-aware descending), cached for the life of the coordinator process; fallbacks `grok-2-image`, `gpt-image-1`, `muse-image-1.0`. xAI gets `n: 1` and `response_format: 'b64_json'` and the aspect ratio appended to the prompt as text; OpenAI and Meta get `size` `1024x1024` (1:1), `1024x1536` (4:5, 9:16) or `1536x1024` (16:9). The file type is decided by the returned bytes (PNG, JPEG, WebP), never by what the service claims. If the service returns a URL, the image is downloaded.

**Compose.**

```
compose_image(input) ─► load biblioteca/ (palettes, recipes, pieces, fonts, logo)
   └► pick template, palette, background, font (from `seed` when unnamed)
   └► fit text, force readable contrast, sanitize svg_overlay
   └► write imagenes/<slug>-<YYYYMMDD>-<HHMMSS>.svg
   └► host.request image.render { svg, width, height, outPath }  ──► main (render.ts)
   └◄ host.result { ok, message }                                      hidden sandboxed window,
   └► "Imagen guardada: <png>" + "SVG editable: <svg>" + summary         only data:/about: URLs, 300 ms font wait
```

The same seed and input give the same SVG byte for byte; with no seed a random one is used and printed in the summary so a variant can be re-requested. Text size is an estimate from average glyph width per font; the real wrapping is done by the renderer.

**Look.** `look_at_image` loads the picture (allowed only from the inbox, the active vault and the working folder; relative paths resolve against the inbox first), then `look` sends one user message (images then the question) with effort `low` and no tools to the vision model. `resolveVision` (settings alone, no network, read at every look so a camera watch obeys a change without a restart) decides who looks, in order:

1. `settings.images.vision` with a provider **and** a typed model: that pair, used as is, with no listing call, no capability check and no acknowledgement needed (a pair carried over from Casa keeps working as it did).
2. `images.vision` with a provider and an empty model, and the provider in `attachments.noticeAcknowledged`: that provider. `visionModel` then completes the model: a provider with no capability rule (DeepSeek, Vercel) fails with `tool.vision.noModel` and makes no listing call; otherwise it lists the provider's models with its key, takes the newest id its rule accepts (`pickSeeModel`) and caches the pick in memory per provider + base URL + key for the life of the coordinator. A listing failure, a missing key or a listing with no accepted id is a tool error (`tool.vision.listFailed` with the provider's own message, or `tool.vision.noModel`); it is not cached and the picture is sent to no other provider.
3. Otherwise (nothing chosen, or a provider-only value the person never acknowledged, which the card reports as held): the agent that runs the house; the default agent; any agent whose provider has a key; the first agent. No capability check; if that agent's model cannot see, the provider's own error comes back.

The capability table (`SEE_RULES`, one entry per provider; an id is accepted only by its provider's entry and a provider marked `none` accepts nothing, so a missing entry fails typecheck) answers the open question of [providers](providers.md) "which is true for vision?" as follows: Anthropic `claude-*`; xAI `grok-*` ids that also pass the chat-model filter (`isChatModel`, which drops any id containing `vision`, so such an id is never auto-picked but still works when typed); Meta `muse-spark*`; DeepSeek none; Vercel AI Gateway none. DeepSeek and Vercel are `none` because the Providers tab labels both «solo texto» and their ids mix labs; a model typed by hand still works, and flipping either to "can see" is a change of that one entry.

**Show.** The tool card finds the line "Imagen guardada: <path>" in the result and renders it through `WorkspaceImage`, which asks `files.image { threadId, path }` and gets a data URL.

## Tools for agents

| Name | Risk | Asks approval | Purpose |
|---|---|---|---|
| `generate_image` | `write` | per mode | Image from a prompt (min. 10 characters), ratio 1:1 (default), 4:5, 16:9, 9:16, saved in `imagenes/`. |
| `compose_image` | `write` | per mode | Original image from the library; SVG plus PNG in `imagenes/`. Needs a working folder. |
| `look_at_image` | `read` | no | Ask a vision model a question about a picture; standalone. |

The default agents Multimedia and Community Manager list the first two as auto-approved (preparing a post does not wait; publishing does), and a company agent auto-approves both. See [references/tools.md](../references/tools.md).

## Settings and data

| What | Default | Where |
|---|---|---|
| `settings.images.provider` | `xai` | `settings.json` |
| `settings.images.model` | empty (newest) | `settings.json` |
| Service keys | from provider settings or env `XAI_API_KEY`, `OPENAI_API_KEY`, `META_API_KEY` | see [providers](providers.md) |
| `settings.images.vision` | `{ provider: '', model: '' }` («Automático»: the agent chain, see Look) | `settings.json` |
| `settings.visionMigrated` | unset | `settings.json`; the one-time move of the old Casa fields (`home.visionProvider`/`visionModel`) into `images.vision`, which are then removed from `home` |
| `attachments.noticeAcknowledged` | `[]` | `settings.json`; the providers the person confirmed by name; a provider-only see value is used only if it is here |
| Output | `imagenes/` in the working folder | `<slug>-<YYYYMMDD>-<HHMMSS>.png/.jpg/.webp/.svg`, local time |
| Brand library | `biblioteca/` in the working folder | see above |
| Pictures you send (Telegram, and chat before spec 030) | `<userData>/inbox/` | `<time-base36>-<name>` |
| Pictures attached in the chat composer (spec 030) | `<userData>/inbox/attachments/<id>/<name>` | stored without EXIF/GPS, 2 MiB at most, deleted 30 days after the conversation was last opened (see [chat](chat.md)) |

Slug: accents and punctuation removed, lower case, dashes, 40 characters, falling back to the prompt and then `imagen`.

## Limits and rules

| What | Value |
|---|---|
| `generate_image` prompt | at least 10 characters |
| `compose_image` text | title 140, subtitle 200, text 600, badge 32, footer 80 characters; at most 30 extra elements; `svg_overlay` 20 000 characters |
| Element position / size | x, y from -0.5 to 1.5; size 0.01–1.5 of the short side (default 0.25) |
| Canvas | 1:1 1080×1080, 4:5 1080×1350 (default), 16:9 1920×1080, 9:16 1080×1920 |
| Library | 12 templates, 16 palettes in 4 styles, 7 bundled fonts, 10 backgrounds, 23 shapes (spec; the README says 22) |
| `biblioteca/` files | over 8 MB, directories, symlinks and unsupported extensions are skipped silently |
| Text contrast | forced readable: ink replaced (`#111111` or `#ffffff`) when contrast against the background is under 3 |
| Vision picture | jpg, jpeg, png, webp, gif, at most 8 MB |
| UI preview | PNG, JPEG, WebP only, at most 12 MB (no GIF, no SVG) |
| Render wait | fixed 300 ms |

## Security and privacy

- The generation prompt leaves the machine to the image service; a picture given to `look_at_image` leaves it to the vision model's provider. Compose runs fully offline (fonts are bundled).
- No picture or camera still reaches a see provider the person only clicked in a dropdown: a provider chosen without a model is used only after it was confirmed by name (the dialog saves the acknowledgement in the same update), and until then the agent chain is used. The attachment notice names the provider the looks would use after that same gate, from settings alone, so it never depends on the listing. Residual cases are in [security](../security/PRIVACY.md) (a complete provider + model pair carried over from Casa and never acknowledged keeps receiving camera stills, as before). Listing models sends the provider's key to that provider; the listing error text is passed through an exact-key replacement before it becomes a tool error, and no key appears in logs or tool results.
- Model-written SVG is sanitized (scripts, `foreignObject`, `on…=` handlers and any `href` not pointing to `#…` or `data:image/…` removed) and rasterized in a hidden sandboxed window whose network is blocked.
- Paths from the model are confined: the workspace for generation and preview; the inbox, active vault and working folder for vision.
- Pictures in the inbox are never deleted automatically, except those attached in the chat (spec 030), which are deleted 30 days after their conversation was last opened. The privacy erase action ("Borrar mis datos", see [security](security.md)) removes the whole inbox.

## How it is tested

- `tests/compose.test.ts`: all templates in all formats and determinism, escaping and font embedding, unknown names, contrast, overlay sanitizing, text fitting, writing SVG and asking for PNG, the whole `biblioteca/` (palettes, pieces, fonts, logo, recipes).
- `tests/media.test.ts`: newest-model pick and save, model choice per provider, missing key message.
- `tests/home.test.ts`: image size from PNG, GIF and JPEG headers.
- Spec 038 (every title starts with `AC-x.y (038)`): `tests/images-models.test.ts` (the capability table, classification, `newestModel`, candidates, provider lists), `tests/images-vision-rules.test.ts` (the gate, `sanitizeImagesSettings`, `acceptImagesPatch`, the migration, `planSeeProvider`, the notice's provider, the dictionary keys), `tests/images-vision-look.test.ts` (`visionModel`/`look` against a fake provider: typed model, held provider, no rule, listing cache, failures, key never in an error), `tests/images-vision-store.test.ts` (`SettingsStore` load, migration and update), `tests/images-create-models.test.ts` (create model choice against a local server).
- Not covered: WebP size, non-xAI request shapes, URL download, abort, the render window, `loadPicture` limits and roots, Telegram photos, `files.image` limits, and the whole renderer part of spec 038 (the see card, the confirmation dialog, Casa's line): there are no component tests.
- Not verified when this was written: nothing of spec 038 was rendered or clicked (the manual check of task T20 is pending), no real provider was called (task T34: whether the ids the table accepts really come back from Anthropic, xAI and Meta, and whether the newest one really sees, is unobserved), the dialog's portal to `document.body` and its capture of Escape (so it does not also close Settings) are reasoned from the code and not seen, and a gamepad cannot reach the model inputs and selects of either card (native controls, as the rest of Settings).
- By hand: paste a screenshot, send it and watch the agent call `look_at_image`; generate or compose and see the image in the card; point a card at a deleted file («No se pudo mostrar <path>: <reason>»); open «Configuración → Imágenes» with and without keys.

## Known limits

1. **Likely bug, confirmed in the code:** `saveInboxImage` (`src/coordinator/index.ts`, around line 352) cleans names with `/[^w.-]+/g`, a literal `w`, not `\w`. Every other letter and digit becomes `_`, so `telegram-AgAD1.jpg` is stored as `<time>-_-_._` and the extension is lost. `look_at_image` decides the type by extension, so a picture pasted in the chat or sent by Telegram would answer «Solo se pueden mirar imágenes JPG, PNG, WebP o GIF.» (only JPG, PNG, WebP or GIF can be viewed). It looks like a missing backslash. Spec 030 moved the character step to `shared/attach/names.ts` (`\w`) and `inboxFileName` now uses it, so this no longer happens.
2. `loadPicture` checks roots with `startsWith` and no path separator, so `C:\trabajo-secreto` passes for a root `C:\trabajo`.
3. If the model list fails once, the fallback model is cached until restart.
4. The settings model lists (create and see) are sorted alphabetically (ascending), while the automatic pick is the greatest id in numeric-aware order. Since spec 038 the create list no longer shows `video`/`edit` ids. The "newest" model is the last id in that order, not the latest release: across families it is an order of ids (for Anthropic it lands on the family whose name sorts last), and a better model can always be typed.
5. Preview accepts only PNG/JPEG/WebP, vision accepts GIF, composed SVG cannot be shown.
6. The vision system prompt says «un asistente de domótica» (a home-automation assistant) even for unrelated chat pictures.
7. On xAI the aspect ratio is only a text hint, so the real size is whatever the service returns, which matters for Instagram 4:5. Product decision.
8. The inbox has no size or age limit. Product decision.
9. Minor doc drift: the README table says 22 shapes, the spec 23.
10. Choosing DeepSeek or Vercel for seeing needs a typed model (the confirmation requires one). A provider saved with an empty model that has no rule (a stored value edited by hand, or a legacy provider already acknowledged elsewhere) fails every look, camera watches included, with `tool.vision.noModel`; nothing falls back, by design.
11. A successful see-model pick is cached for the process and never expires: a newer model appearing mid-session is picked up after a restart or by typing it. A failed listing is not cached (unlike creation, which keeps its fallback id until restart, limit 3).

## See also

[instagram](instagram.md) · [home](home.md) (cameras and plans use `look`) · [telegram](telegram.md) · [providers](providers.md) · [office-and-drawings](office-and-drawings.md) (the SVG to PNG renderer) · [files-and-commands](files-and-commands.md) · [security](security.md) · [references/tools.md](../references/tools.md) · README section «Biblioteca de imágenes»
