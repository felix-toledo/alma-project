# 020 — Plan

## 1. Approach
Three independent capabilities behind plain tools. `generate_image` is a thin call to the image service chosen in settings (xAI by default, OpenAI or Meta), with the model resolved lazily to "the newest image model" so nobody maintains a model id. `compose_image` is a deterministic SVG composer in the coordinator (template + palette + font + background + shapes + the person's `biblioteca/`), rasterized to PNG by the main process, so a provider that cannot draw (Claude, DeepSeek) can still deliver an on-brand post. `look_at_image` is a one-shot vision call that returns text: agents never carry pixels in their conversation, they carry a path.

Rejected: letting agents hold images as content blocks in the conversation. It would make every provider path handle images, bloat saved threads and leak pictures into every later turn; a one-shot `look` keeps the picture exactly as long as the question. Rasterizing in the coordinator (a canvas library) was also rejected: the coordinator is a utility process with no DOM, and adding a native dependency for one PNG was worse than a hidden Electron window in main (see [ADR 0001](../../../docs/adr/0001-coordinator-as-utility-process.md) for why the coordinator has no `electron`).

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | `src/shared/types.ts` (`ImageProviderId`, `Settings.images`, `HostRequest` `image.render`, requests `images.models`, `files.image`, `files.saveImage`), `src/shared/defaults.ts` (default `images`, default agents auto-approve the two image tools) | Types used by coordinator, main and renderer; no logic |
| coordinator | `src/coordinator/images.ts` (providers, model pick, MIME sniff), `src/coordinator/vision.ts` (`loadPicture`, `look`, `imageSize`, `visionModel`), `src/coordinator/tools/media.ts` (`generate_image`, `compose_image`, `imageDataUrl`), `src/coordinator/tools/home.ts` (`look_at_image`), `src/coordinator/compose/index.ts` + `library.ts` (composer, user library, SVG sanitizer), `src/coordinator/index.ts` (inbox, `files.*`, `images.models` handlers), `src/coordinator/channels/telegram.ts` (photos) | Model calls, file access and tools belong to the agent engine; compose is pure so it is testable without Electron |
| main | `src/main/render.ts` (`renderSvgToPng`), `src/main/settings.ts` (clears a key pasted in the model field on load) | Only main can open a hidden window; it answers the `image.render` host request, and it owns `settings.json` |
| renderer | `src/renderer/src/components/WorkspaceImage.tsx`, `ToolCard.tsx`, `src/renderer/src/lib/format.ts` (finds the "Imagen guardada" line), `ChatView.tsx` (paste/drop), `SettingsDialog.tsx` (Imágenes tab) | Display and input only; every file read goes through a coordinator request |

No new arrow breaks `docs/architecture.md`: `compose/` imports nothing from `main`; the PNG step is a `HostRequest`.

## 3. Contracts
- Types: `AspectRatio = '1:1' | '4:5' | '16:9' | '9:16'`; `ImageProviderId = 'xai' | 'openai' | 'meta'`; `Picture { mediaType, data, width?, height? }`; `ComposeInput` (Zod `ComposeSchema`), `Composition { svg, width, height, summary }`, `UserLibrary`.
- Functions: `pickImageModel(provider, ids)`, `imageMimeType(bytes)`, `listImageModels(settings, provider?)`, `generateImage(settings, prompt, aspect, signal)`, `imageSize(bytes)`, `visionModel(settings)`, `loadPicture(path, roots)`, `look(settings, pictures, question, signal)`, `compose(input, library)`, `loadLibrary(dir)`, `sanitizeSvg(fragment)`, `fitFontSize(...)`, `renderSvgToPng(request)`.
- Tools: `generate_image` (`write`), `compose_image` (`write`), `look_at_image` (`read`, `standalone`).
- Host request: `{ action: 'image.render'; svg; width; height; outPath }` answered `{ ok, message }`.
- Renderer requests: `files.saveImage { name, base64 }` returns the stored path; `files.image { threadId, path }` returns a data URL; `images.models { provider? }` returns ids.

## 4. Data and persistence
- `imagenes/<slug>-<YYYYMMDD>-<HHMMSS>.{png,jpg,webp,svg}` in the working folder; `biblioteca/` (pieces, fonts, `paletas.json`, `recetas.json`) in the working folder, read-only for the tools.
- `<userData>/inbox/<time-base36>-<name>` for pictures the person pastes, drops or sends by Telegram; never deleted automatically (only "Borrar mi historial", see 022).
- `settings.json` gains `images: { provider, model }`; empty model means "newest available". The resolved model is cached per service + URL + key for the life of the coordinator process.

## 5. Dependency injection
- `generateImage` builds its client from `Settings`, so tests point `providers.xai.baseUrl` at a local HTTP server and need no mock of the SDK.
- `compose` is a pure function of `(input, library)`; `loadLibrary` takes a directory, tests use a temp folder.
- `compose_image` reaches the PNG step only through `ctx.host.request`, so tests pass a fake host that records the `image.render` request.
- `look` resolves the provider through `getProvider`; `loadPicture` takes the allowed roots as an argument.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1–1.4 | `tests/media.test.ts` → "picks the newest image model and saves the image in the workspace" | accents in the filename, ratio hint in the prompt |
| AC-1.8 | `tests/media.test.ts` → "explains a missing key" | env var removed as well |
| AC-2.1 | `tests/media.test.ts` → "chooses image models per provider" | video and edit models excluded |
| AC-3.1 | `tests/compose.test.ts` → "draws every template in every format, deterministically per seed" | every template x every ratio |
| AC-3.2 | `tests/compose.test.ts` → "escapes text and embeds only the fonts it uses" | `<b>` and `&` in the title |
| AC-3.3 | `tests/compose.test.ts` → "rejects unknown names with the valid options" | palette, element and font |
| AC-3.4 | `tests/compose.test.ts` → "keeps text readable when brand colors would hide it" | near-white text on white |
| AC-3.5 | `tests/compose.test.ts` → "strips scripts, handlers and remote links from overlays" | script, `onclick`, remote `href`, `foreignObject` |
| AC-3.6 | `tests/compose.test.ts` → "fits long titles smaller than short ones" | one very long word |
| AC-3.7 | `tests/compose.test.ts` → "writes the SVG and asks the main process for the PNG" | exact width and height in the host request |
| AC-4.1–4.2 | `tests/compose.test.ts` → "uses palettes, pieces, fonts and the logo from biblioteca/" | invalid palette entry names `paletas.json` |
| AC-4.3–4.5 | `tests/compose.test.ts` → "applies recipes, recolors SVG pieces inline and can drop template decorations" | unknown recipe, handlers stripped from pieces |
| AC-5.4 | `tests/home.test.ts` → "lee el tamaño de PNG, GIF y JPEG por la cabecera" | not an image returns null |
| AC-1.5–1.7, 1.9–1.11, 2.2–2.5, 3.8–3.15, 4.6–4.9, 5.1–5.3, 5.5–5.8, 6.2–6.5, 7.3–7.4 | [gap] | backlog: non-image bytes, URL download failure, symlink and 8 MB library files, root prefix |
| AC-2.6–2.7, 6.1, 7.1–7.2 | [manual] | Configuración → Imágenes with and without keys; paste a screenshot; delete a generated file and reopen the card |

## 7. Security and privacy impact
- `generate_image` and `compose_image` are `write` (they create files); the default Multimedia and Community Manager agents auto-approve them, publishing (`instagram_publish`, `publish`) still asks. `look_at_image` is `read`.
- The prompt leaves the machine to the chosen image service; a picture given to `look_at_image` leaves to the vision provider. Both are listed in `docs/security/PRIVACY.md`.
- Model-written SVG is sanitized and rendered in a window with network blocked; fonts are bundled, so composing needs no network. Paths from the model are confined (workspace for generation and preview; inbox, vault and workspace for vision). Keys are read from settings or the environment and never logged.
- No change to `docs/security/` was needed beyond the existing outbound-hosts table.

## 8. Rollout
No flag: the tools exist for every agent that lists them. Default service is xAI with an empty model (newest). A missing key is reported with a pointer to Configuración → Proveedores and a hint to use `compose_image`, which needs no key. Nothing happens on first run until an agent calls a tool.
