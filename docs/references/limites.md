# Limits and constants reference

Every constant that shapes behavior: timeouts, caps, sizes, iteration limits, intervals, retry counts, truncation limits,
thresholds and default values that act as limits. Grouped by module. Each row was read in the code; `file:line` is relative to
`src/` and points at the line where the number lives (a declared constant, a Zod bound, or an inline literal). Units are in
the "value" column. For what each module does, see [the module docs](../modules/); for the tools themselves see
[herramientas.md](herramientas.md).

Columns: **value** · **what it limits** · **module** · **file:line**.

## Agent loop and tool results

| value | what it limits | module | file:line |
|---|---|---|---|
| 80 model turns | `MAX_ITERATIONS`: one run stops after 80 turns, even if the model keeps calling tools. Also what bounds how many approvals a run can ask for | [agents](../modules/agentes.md) | `coordinator/agent.ts:23` |
| 1 level | Delegation depth: `delegate_task` is only offered at depth 0, so a subagent cannot delegate | agents | `coordinator/agent.ts:260` |
| 60,000 characters | `MAX_RESULT_CHARS`: any tool result sent to the model is cut in the middle (first and last half kept). Error results from thrown errors are not cut | agents | `coordinator/tools/types.ts:85`, `coordinator/agent.ts:427` |
| effort `low` | Voice conversations at top level run with low effort whatever the profile says | agents / [voice](../modules/voz.md) | `coordinator/agent.ts:277` |
| 6 tools | `COMPANY_AUTO_APPROVE`: tools a company agent runs without asking | [approvals](../modules/aprobaciones.md) | `coordinator/agent.ts:25` |
| 4,000 characters | Task context the auto-review reviewer sees (the user's latest request) | approvals | `coordinator/approval.ts:83` |
| 8,000 characters | Tool input (as JSON) the reviewer sees; same cut for the boss review | approvals | `coordinator/approval.ts:84`, `coordinator/approval.ts:126` |
| 3,000 / 4,000 characters | Boss's own instructions / the request shown to the boss in a boss review | approvals | `coordinator/approval.ts:124`, `coordinator/approval.ts:125` |
| no limit | A pending approval has no timeout; it ends with an answer or with the run's abort signal | approvals | `coordinator/approval.ts:18` |
| 2 attempts | By voice, how many times Alma asks yes or no for an approval | approvals / voice | `coordinator/voice/assistant.ts:320` |
| 1,500 characters | Tool input shown in a Telegram approval message (also in the WhatsApp one) | approvals / Telegram | `coordinator/channels/telegram.ts:252`, `coordinator/channels/whatsapp.ts:285` |
| `needs-approval` | Default approval mode | approvals | `shared/defaults.ts:199` |

## Files and commands

| value | what it limits | module | file:line |
|---|---|---|---|
| 2 MiB | `MAX_READ_BYTES`: largest file `read_file` opens | [files and commands](../modules/archivos-y-comandos.md) | `coordinator/tools/fs.ts:8` |
| 1 MiB | `MAX_SEARCH_FILE_BYTES`: `search_files` skips bigger files | files and commands | `coordinator/tools/fs.ts:9` |
| 8,000 bytes | A file is "binary" if a NUL byte appears in its first 8,000 bytes | files and commands | `coordinator/tools/fs.ts:12` |
| 2,000 lines (default), 1 to 5,000 | Lines `read_file` returns (`limit`) | files and commands | `coordinator/tools/fs.ts:62`, `coordinator/tools/fs.ts:64` |
| 1 to 4 levels, default 1 | Depth of `list_dir` | files and commands | `coordinator/tools/fs.ts:82` |
| 1,000 lines | `list_dir` stops and adds "(listado truncado)" | files and commands | `coordinator/tools/fs.ts:93`, `coordinator/tools/fs.ts:105` |
| 300 matches | `search_files` stops and asks to narrow the search | files and commands | `coordinator/tools/fs.ts:141` |
| 300 characters | Length kept per matching line in `search_files` | files and commands | `coordinator/tools/fs.ts:140` |
| 8 folders | Never searched or descended: `node_modules`, `.git`, `out`, `dist`, `build`, `.next`, `__pycache__`, `.venv` | files and commands | `coordinator/tools/fs.ts:7` |
| 120 s (default), 1 to 600 s | `run_command` timeout (`timeout_seconds`); on timeout the process tree is killed | files and commands | `coordinator/tools/shell.ts:45`, `coordinator/tools/shell.ts:47`, `coordinator/tools/shell.ts:72` |
| 200,000 characters | `MAX_OUTPUT_CHARS`: `run_command` keeps the first and last 200,000 characters of output | files and commands | `coordinator/tools/shell.ts:6`, `coordinator/tools/shell.ts:63` |

## Web and mail

| value | what it limits | module | file:line |
|---|---|---|---|
| 20 s | `TIMEOUT_MS`: each web request (combined with the run's cancel signal) | [web and mail](../modules/web-y-correo.md) | `coordinator/tools/web.ts:9`, `coordinator/tools/web.ts:82` |
| 5 redirects | `MAX_REDIRECTS` for `fetch_url`; each hop is checked against private hosts | web and mail | `coordinator/tools/web.ts:10`, `coordinator/tools/web.ts:109` |
| 1 to 10 results (default 6) | `web_search` `max_results` | web and mail | `coordinator/tools/web.ts:123` |
| 1,000 to 60,000 characters (default 15,000) | `fetch_url` `max_chars` | web and mail | `coordinator/tools/web.ts:152`, `coordinator/tools/web.ts:154` |
| private ranges | `fetch_url` refuses 10/8, 127/8, 0.0.0.0, 169.254/16, 172.16/12, 192.168/16, 100.64/10, `::1`, `::`, `fc/fd/fe80`, IPv4-mapped IPv6 | web and mail | `coordinator/tools/web.ts:70`, `coordinator/tools/web.ts:72` |
| 1 to 50 mails (default 15) | `email_search` `limit` | web and mail | `coordinator/tools/email.ts:74`, `coordinator/tools/email.ts:76` |
| 1 to 3,650 days | `email_search` `since_days` | web and mail | `coordinator/tools/email.ts:72` |
| 20,000 characters | Body of `email_read` is cut in the middle | web and mail | `coordinator/tools/email.ts:124` |
| TLS 1.2 minimum | Minimum TLS version for IMAP and SMTP | web and mail | `coordinator/tools/email.ts:33` |
| 993 / 465 | Default IMAP / SMTP ports (993 and 465 use implicit TLS, others STARTTLS) | web and mail | `shared/defaults.ts:230`, `coordinator/tools/email.ts:37`, `coordinator/tools/email.ts:167` |

## Providers

| value | what it limits | module | file:line |
|---|---|---|---|
| 64,000 tokens | `max_tokens` of every Anthropic chat turn | [providers](../modules/providers.md) | `coordinator/providers/anthropic.ts:104` |
| 4,096 tokens | `max_tokens` of an Anthropic review call (auto-review and boss review) | providers | `coordinator/providers/anthropic.ts:164` |
| 3 attempts | A failed Anthropic stream that is not an API error and not an abort is re-issued, up to the third attempt. API errors are never retried | providers | `coordinator/providers/anthropic.ts:123`, `coordinator/providers/anthropic.ts:155` |
| per-provider prices | USD per million tokens (input / output / cache read), used for company budgets: Anthropic 5 / 25 / 0.5, xAI 3 / 15 / 0.75, DeepSeek 0.3 / 1.2 / 0.03, Vercel 3 / 15 / 0.3, Meta 1.25 / 4.25 / 0.15 | providers / [companies](../modules/empresas.md) | `shared/company.ts:70` |
| 8 MB | Largest picture the vision helper reads | [images](../modules/imagenes.md) | `coordinator/vision.ts:44`, `coordinator/vision.ts:72` |

## MCP

| value | what it limits | module | file:line |
|---|---|---|---|
| 30 s | Connecting to an MCP server | [MCP](../modules/mcp.md) | `coordinator/mcp.ts:99` |
| 300 s | A single MCP tool call | MCP | `coordinator/mcp.ts:144` |
| 64 characters | Total length of the name `mcp__<server>__<tool>` | MCP | `coordinator/mcp.ts:25` |
| 1,024 characters | Length of the description sent to the model | MCP | `coordinator/mcp.ts:45` |

## Chat, threads and privacy

| value | what it limits | module | file:line |
|---|---|---|---|
| 300 ms | Debounce before a thread is written to disk; files are written atomically with mode 0600 | [chat](../modules/chat.md) | `coordinator/store.ts:71`, `coordinator/store.ts:79` |
| 57 characters + "…" (when over 60) | Auto title taken from the first message | chat | `coordinator/index.ts:196` |
| 60 minutes | `VOICE_SESSION_MS`: the voice conversation thread is reused for this long | chat / voice | `coordinator/index.ts:481` |
| 0 days (keep forever) | `privacy.threadRetentionDays` default; the menu offers 30, 90, 180 and 365 days | [security](../modules/seguridad.md) | `shared/defaults.ts:208`, `renderer/src/components/SettingsDialog.tsx:767-770` |
| 12 h | How often the retention cleanup runs (also at start and on every settings change) | security | `coordinator/index.ts:746` |
| 15,000 characters | Each vault attachment in the chat is clipped | chat | `renderer/src/lib/attachments.ts:16` |
| 80 px | The chat follows new output only while you are within 80 px of the end | chat | `renderer/src/components/ChatView.tsx:154` |
| 12 MB | Largest workspace image previewed in the chat or in an Instagram approval (PNG, JPEG, WebP) | chat / [Instagram](../modules/instagram.md) | `coordinator/tools/media.ts:10` |

## Vault and knowledge

| value | what it limits | module | file:line |
|---|---|---|---|
| 5 MiB | `MAX_NOTE_BYTES`: bigger notes are not opened or indexed | [vault and knowledge](../modules/vault-y-conocimiento.md) | `coordinator/knowledge/base.ts:16`, `coordinator/knowledge/base.ts:162`, `coordinator/knowledge/base.ts:296` |
| 4,000 characters | `MAX_MEMORY_CHARS`: all memories together when adding with `remember` | vault and knowledge | `coordinator/knowledge/base.ts:22`, `coordinator/knowledge/base.ts:358` |
| 3 to 300 characters | One `remember` input | vault and knowledge | `coordinator/knowledge/tools.ts:61` |
| 1,600 / 200 characters | Largest chunk / chunks below 200 are merged with the next | vault and knowledge | `coordinator/knowledge/markdown.ts:12`, `coordinator/knowledge/markdown.ts:13` |
| 8 chunks | `EMBED_BATCH`: chunks embedded per batch | vault and knowledge | `coordinator/knowledge/base.ts:17`, `coordinator/knowledge/base.ts:184` |
| 60 | `RRF_K`: Reciprocal Rank Fusion constant | vault and knowledge | `coordinator/knowledge/base.ts:18` |
| 0.45 | `RECALL_MIN_SIMILARITY`: minimum cosine similarity for automatic recall | vault and knowledge | `coordinator/knowledge/base.ts:20`, `coordinator/knowledge/base.ts:254` |
| 0.9 | `DUPLICATE_SIMILARITY`: `save_knowledge` treats a note as a duplicate at this similarity or more (among the 3 nearest chunks) | vault and knowledge | `coordinator/knowledge/base.ts:21`, `coordinator/knowledge/base.ts:392` |
| 30 candidates, 5 fragments, 2 per file | Automatic recall into the system prompt | vault and knowledge | `coordinator/knowledge/base.ts:248-257` |
| 40 candidates, 400 characters | Search depth for each ranking, and the snippet length shown in results | vault and knowledge | `coordinator/knowledge/base.ts:231`, `coordinator/knowledge/base.ts:234` |
| 24 words | A query keeps at most 24 words for the keyword search | vault and knowledge | `coordinator/knowledge/base.ts:31` |
| 1 to 20 results (default 8) | `search_knowledge` `limit` | vault and knowledge | `coordinator/knowledge/tools.ts:19` |
| 1024 dimensions | Embedding vector size (model `Xenova/bge-m3`) | vault and knowledge | `coordinator/knowledge/db.ts:5`, `coordinator/knowledge/embedder.ts:6` |
| 400 ms | Debounce of the folder watcher before a rescan | vault and knowledge | `coordinator/knowledge/base.ts:114` |
| 700 ms | Editor autosave delay after the last keystroke | vault and knowledge | `renderer/src/vault/useVault.ts:16` |
| 50 results | Quick switcher list | vault and knowledge | `renderer/src/vault/panels.tsx:17`, `renderer/src/vault/panels.tsx:22` |
| 250 ms | Search panel debounce | vault and knowledge | `renderer/src/vault/panels.tsx:91` |
| 500 rows | Spreadsheet preview cap per sheet | [office and drawings](../modules/office-y-dibujos.md) | `renderer/src/vault/DocumentPreview.tsx:11` |

## Office documents

| value | what it limits | module | file:line |
|---|---|---|---|
| 50 MB | `MAX_BYTES`: largest Office/PDF file the tools open (size of the file, not of what the zip inflates to) | office and drawings | `coordinator/tools/office/common.ts:10`, `coordinator/tools/office/common.ts:39` |
| 3,000 cells | `MAX_CELLS`: non-empty cells shown per `office_read` call on Excel/CSV | office and drawings | `coordinator/tools/office/xlsx.ts:6` |
| 2,000 characters | Re-read text returned after `office_create` | office and drawings | `coordinator/tools/office/index.ts:142` |

## Images and Instagram

| value | what it limits | module | file:line |
|---|---|---|---|
| 1080x1080, 1080x1350, 1920x1080, 1080x1920 | Output sizes of `compose_image` for 1:1, 4:5, 16:9, 9:16; default aspect 4:5 | images | `coordinator/compose/index.ts:28`, `coordinator/compose/index.ts:624` |
| 1024x1024, 1024x1536, 1536x1024 | OpenAI image sizes mapped from the aspect ratios | images | `coordinator/images.ts:15-19` |
| 140 / 200 / 600 / 32 / 80 characters | `compose_image` title / subtitle / text / badge / footer | images | `coordinator/compose/index.ts:292-296` |
| 30 elements, 20,000 characters | Extra elements and SVG overlay of `compose_image` | images | `coordinator/compose/index.ts:310`, `coordinator/compose/index.ts:320` |
| -0.5 to 1.5; 0.01 to 1.5 (default 0.25) | Position (x, y) and relative size of an extra element | images | `coordinator/compose/index.ts:301-303`, `coordinator/compose/index.ts:509` |
| 4 accents | Maximum accent colors in a recipe | images | `coordinator/compose/index.ts:279` |
| 8 MiB | Largest library piece (logo, photo) `compose_image` loads | images | `coordinator/compose/index.ts:356`, `coordinator/compose/index.ts:419` |
| 10 characters | Minimum prompt of `generate_image` | images | `coordinator/tools/media.ts:46` |
| 300 ms | Wait before rasterizing an SVG so fonts apply | images | `main/render.ts:13` |
| 2,200 characters | `CAPTION_LIMIT`: Instagram caption | Instagram | `coordinator/tools/media.ts:11`, `coordinator/tools/media.ts:89` |
| 30 hashtags | `HASHTAG_LIMIT` | Instagram | `coordinator/tools/media.ts:12`, `coordinator/tools/media.ts:98` |
| `testMode: true` | Default: the automation never clicks "Compartir" | Instagram | `shared/defaults.ts:205` |
| 30 s | Page loaded; "Crear" button; each "Siguiente" | Instagram | `main/instagram.ts:254`, `main/instagram.ts:256`, `main/instagram.ts:266` |
| 5 s / 20 s / 20 s | "Publicación" menu option / file input / caption box | Instagram | `main/instagram.ts:259`, `main/instagram.ts:262`, `main/instagram.ts:271` |
| 20 s | "Compartir" button must be stable before the one click | Instagram | `main/instagram.ts:286` |
| 180 s | Wait for the success confirmation | Instagram | `main/instagram.ts:289` |
| 3 tries, 6 s each | A click that did not change the screen is retried up to 3 times; "Compartir" is clicked once and never retried | Instagram | `main/instagram.ts:184`, `main/instagram.ts:190` |
| 500 ms | Polling interval of the waits | Instagram | `main/instagram.ts:152` |
| 2.5 s | After a real publish the window closes after this delay (in test mode it stays open) | Instagram | `main/instagram.ts:305` |

## Telegram and WhatsApp

| value | what it limits | module | file:line |
|---|---|---|---|
| 4,096 characters | `TELEGRAM_LIMIT`: one Telegram message; longer text is split at `\n\n`, `\n` or `. ` found after half the limit | [Telegram](../modules/telegram.md) | `coordinator/channels/telegram.ts:6`, `coordinator/channels/telegram.ts:33-37` |
| 1,500 ms | `STATUS_EDIT_MS`: the "Pensando…" message is edited with tool names at most this often | Telegram | `coordinator/channels/telegram.ts:7` |
| 1,000 characters | Caption of a photo sent by the bot | Telegram | `coordinator/channels/telegram.ts:136` |
| 1 to 20,000 characters | `send_telegram` text | Telegram | `coordinator/tools/telegram.ts:12` |
| 2 minutes | `STALE_MS`: WhatsApp messages older than this at arrival are treated as synced history and ignored | [WhatsApp](../modules/whatsapp.md) | `coordinator/channels/whatsapp.ts:16` |
| 300 messages | `RECENT_LIMIT`: received messages kept in memory for `whatsapp_recent` (lost on restart) | WhatsApp | `coordinator/channels/whatsapp.ts:14` |
| 3 s (0 s if WhatsApp asks for a restart) | Reconnect delay after a closed connection | WhatsApp | `coordinator/channels/whatsapp.ts:156` |
| 4,000 characters | One WhatsApp reply message | WhatsApp | `coordinator/channels/whatsapp.ts:225` |
| 8 digits | A target with this many digits and no letters is a phone number; otherwise a contact name | WhatsApp | `coordinator/channels/whatsapp.ts:249` |
| 8 names | Ambiguous contact matches listed in the error | WhatsApp | `coordinator/channels/whatsapp.ts:257` |

## Routines and reminders

| value | what it limits | module | file:line |
|---|---|---|---|
| 30 s | `TICK_MS`: how often the runner checks the schedule (and once 5 s after start) | [routines](../modules/rutinas.md) | `coordinator/routines.ts:6`, `coordinator/routines.ts:35` |
| 5 minutes | Minimum of an interval routine created by a tool | routines | `coordinator/tools/routines.ts:18` |
| 60 s | A `once` date may be at most this far in the past | routines | `coordinator/tools/routines.ts:33` |
| 2 / 3 / 10 characters | Minimum reminder message / routine name / routine task | routines | `coordinator/tools/routines.ts:57`, `coordinator/tools/routines.ts:85`, `coordinator/tools/routines.ts:86` |
| 6 base-36 characters | Random part of the id `rutina-xxxxxx` | routines | `coordinator/tools/routines.ts:47` |
| 60 characters (57 + "…") | Reminder name derived from its message | routines | `coordinator/tools/routines.ts:64` |
| 1 minute | Minimum interval the scheduler itself accepts for an interval schedule | routines | `shared/schedule.ts:28`, `shared/schedule.ts:41` |

## Companies

| value | what it limits | module | file:line |
|---|---|---|---|
| 2 revisions | `MAX_REVISIONS`: a task sent back from review more than twice is blocked and the person is notified | [companies](../modules/empresas.md) | `coordinator/company/engine.ts:19`, `coordinator/company/engine.ts:226` |
| 30 s | `TICK_MS`: the engine checks tasks and meetings; first check 8 s after start | companies | `coordinator/company/engine.ts:20`, `coordinator/company/engine.ts:53-54` |
| 15 s | A review whose creator is busy retries after this | companies | `coordinator/company/engine.ts:265` |
| 2 hours (default), 0 to 48 | Meeting preparation lead time (`prep_hours`; the window form defaults to 2 too) | companies | `coordinator/tools/company.ts:125`, `coordinator/tools/company.ts:127`, `renderer/src/companies/CompaniesView.tsx:551` |
| 1 to 8 items | Meeting agenda length | companies | `coordinator/tools/company.ts:122` |
| `min(60, agenda x (others + 1) + 6)` turns | Cap on spoken turns in a meeting | companies | `coordinator/company/engine.ts:470` |
| 120 words | Maximum length of a turn in a meeting (asked in the prompt) | companies | `coordinator/company/engine.ts:477` |
| 12 lines | Length of a participant's preparation (asked in the prompt) | companies | `coordinator/company/engine.ts:442` |
| 60 characters | Topic length used in the minutes file name | companies | `coordinator/company/engine.ts:555` |
| 300 entries (150 sent to the window) | Activity log kept / sent | companies | `coordinator/company/store.ts:16`, `coordinator/company/engine.ts:85` |
| 80 % and 100 % | Budget warning thresholds, once per month per cap | companies | `coordinator/company/engine.ts:119` |
| USD 20 | Monthly budget of a new company (members start at 0 = only the company's cap) | companies | `renderer/src/companies/TeamsSettings.tsx:97`, `renderer/src/companies/TeamsSettings.tsx:109` |

## Home

| value | what it limits | module | file:line |
|---|---|---|---|
| `2026.10.1` | `HA_VERSION`: pinned Home Assistant version | [home](../modules/casa.md) | `coordinator/home/engine.ts:13` |
| 6.5 GB | `NEEDED_BYTES`: free disk required to install | home | `coordinator/home/engine.ts:21` |
| 2.6 GB | `ROOTFS_BYTES`: assumed size, for the progress bar | home | `coordinator/home/engine.ts:19` |
| 8123, then 18123 | `DEFAULT_PORT`, `ALT_PORT` | home | `coordinator/home/engine.ts:22-23` |
| 8 minutes | `BOOT_TIMEOUT_MS`: wait for the engine to boot | home | `coordinator/home/engine.ts:24` |
| 3 restarts in 10 minutes | After that the engine goes to `error` | home | `coordinator/home/engine.ts:466-467` |
| 60 s / 120 s | Timeout for unpacking crane / installing SonoffLAN | home | `coordinator/home/engine.ts:353`, `coordinator/home/engine.ts:391` |
| 120 s / 20 s / 15 s | Timeouts for `wsl --unregister` / `--terminate` / `--status` | home | `coordinator/home/engine.ts:506`, `coordinator/home/engine.ts:480`, `coordinator/home/engine.ts:94` |
| 30 s | Timeout for REST and WebSocket calls to Home Assistant | home | `coordinator/home/ha.ts:21-22` |
| 45 s | Timeout of the history request | home | `coordinator/home/hub.ts:368` |
| 3,650 days | Lifetime of the long-lived token | home | `coordinator/home/ha.ts:222` |
| 300 ms / 500 ms | Debounce of state snapshots / of registry reloads | home | `coordinator/home/hub.ts:15`, `coordinator/home/hub.ts:133` |
| 1 s x 2^n, max 30 s | Reconnect backoff to Home Assistant | home | `coordinator/home/hub.ts:90` |
| 6 tries, 2 s apart, 20 s each | Fetching a camera still | home | `coordinator/home/hub.ts:351-356` |
| 40 x 1.5 s | Polling of a device-add flow step | home | `coordinator/home/flow.ts:220-221` |
| 700 ms / 900 ms | Pause after `home_control` / `home_secure_control` before reporting state | home | `coordinator/tools/home.ts:198`, `coordinator/tools/home.ts:230` |
| 10 to 900 s (default 60) | `camera_watch` interval; the engine enforces at least 10 s | home | `coordinator/tools/home.ts:509`, `coordinator/home/triggers.ts:10` |
| 1 to 360 minutes (default 60) | `camera_watch` duration; capped at 6 hours | home | `coordinator/tools/home.ts:508`, `coordinator/home/triggers.ts:11` |
| 120 s and 5x interval | After a match with `repeat`, the next look waits at least this | home | `coordinator/home/triggers.ts:160` |
| 1 s / 5 s | First look after starting a watch / saved watches resume after start | home | `coordinator/home/triggers.ts:109`, `coordinator/home/triggers.ts:47` |
| 10 minutes (default), at least 1 | Cooldown between wake-ups of a judgment rule | home | `coordinator/tools/home.ts:608`, `coordinator/home/triggers.ts:71` |
| 1 to 168 hours (default 24) | `home_history` window | home | `coordinator/tools/home.ts:659` |
| 0 to 100 | Brightness, position, volume, fan speed | home | `coordinator/tools/home.ts:76-82` |
| 2700 / 4000 / 6000 K | "cálida" / "neutra" / "fría" color temperatures | home | `coordinator/tools/home.ts:71` |
| 1200 cm | A drawing or an image is scaled so the floor's longest side measures this | home | `shared/home.ts:328`, `shared/home.ts:342`, `shared/home.ts:413` |
| 15 % | A closed line in a drawing needs its ends within 15 % of its size | home | `shared/home.ts:355` |
| `enabled: false` | Home is off by default | home | `shared/defaults.ts:234` |

## Voice

| value | what it limits | module | file:line |
|---|---|---|---|
| 80 ms | Audio chunk length | [voice](../modules/voz.md) | `coordinator/voice/speech.ts:87` |
| 25 chunks (2 s) / 8 chunks | Ring kept for the speaker check / pre-roll when interrupting | voice | `coordinator/voice/assistant.ts:15-16` |
| 120 s | `PLAYBACK_TIMEOUT_MS`: wait for the window to report the end of playback | voice | `coordinator/voice/assistant.ts:17` |
| 4 s / 15 s | Wait for speech to start / maximum length of one recording | voice | `coordinator/voice/speech.ts:94` |
| 1,100 ms / 750 ms / 2 s | Silence that ends a recording: 1,100 ms (`longSilenceMs`) when the person has spoken less than 2 s (`shortSpeechMs`), 750 ms (`shortSilenceMs`) after longer speech | voice | `coordinator/voice/speech.ts:94`, `coordinator/voice/speech.ts:133-134` |
| RMS 0.012 | Minimum speech energy | voice | `coordinator/voice/speech.ts:94` |
| RMS 0.035, 3x echo, 5 chunks | Barge-in: chunks louder than this, in a row (400 ms) | voice | `coordinator/voice/speech.ts:150` |
| 10 s / 6 s | Follow-up window after an answer that ends in a question / otherwise | voice | `coordinator/voice/speech.ts:186` |
| 280 characters | Longest sentence sent to the voice engine | voice | `coordinator/voice/speech.ts:28` |
| 0.5 | `wakeThreshold` default (the worker only reports scores above 0.2) | voice | `shared/defaults.ts:215`, `coordinator/voice/voice-worker.ts:146` |
| 0.86 | `speakerThreshold` default | voice | `shared/defaults.ts:219` |
| 5.5 s per phrase, 3.5 s test; warning below 0.75 | Speaker enrollment | voice | `renderer/src/components/SettingsDialog.tsx:1182`, `renderer/src/components/SettingsDialog.tsx:1242`, `renderer/src/components/SettingsDialog.tsx:1234` |
| `enabled: false` | Voice is off by default | voice | `shared/defaults.ts:213` |

## Security, audit and app shell

| value | what it limits | module | file:line |
|---|---|---|---|
| 13 months | `AUDIT_RETENTION_MONTHS`: audit files older than this are dropped | [security](../modules/seguridad.md) | `shared/audit.ts:25` |
| 300 characters | `DETAIL_LIMIT`: any string detail in an audit entry | security | `shared/audit.ts:27` |
| 60 s | Identical audit events within this window are not written twice | security | `shared/audit.ts:77` |
| 1280x820 (minimum 860x560) | Main window size | [app shell](../modules/app-shell.md) | `main/index.ts:223-226` |
| `backgroundThrottling: false` | Voice keeps working with the window hidden | app shell | `main/index.ts:238` |
| 0.7 | Default UI sound volume | app shell | `renderer/src/umbra/useUISound.ts:14` |
| 380 ms, then 120 ms | Gamepad repeat delay | app shell | `renderer/src/umbra/FocusManager.tsx:80-81` |
| 0.6 | Gamepad stick threshold | app shell | `renderer/src/umbra/FocusManager.tsx:88` |

Written by hand from the code; when you add a row, verify the name in the code.
