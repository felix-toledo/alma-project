# 011 — Plan

## 1. Approach
The channel is a Baileys socket owned by the coordinator: Alma links to the person's own number as one more device (QR, like WhatsApp Web) and listens on that socket. The channel is deliberately narrow: it answers only the owner's self chat ("Mensajes para mí"), marks its own messages with a robot prefix, never initiates, and writes to anyone else only through `send_whatsapp`, a `publish` tool that asks on every call. Received messages from others are kept in memory only and exposed through the read-only `whatsapp_recent`. The same channel class is reused, with its own session folder, for a company's own number.
Rejected: the official Meta Cloud API (needs a business account and templates, and cannot sit in the owner's personal chat) — see [ADR 0010](../../../docs/adr/0010-whatsapp-via-baileys.md). The cost is the ban risk, accepted and recorded.

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | `src/shared/types.ts` (`WhatsAppSettings`, `WhatsAppStatus`, events, requests), `src/shared/defaults.ts` (default `whatsapp` setting) | Types and defaults used by coordinator, main and renderer |
| coordinator | `src/coordinator/channels/whatsapp.ts` (new: `WhatsAppChannel`, `phoneDigits`, `RecentMessage`), `src/coordinator/tools/whatsapp.ts` (new: `send_whatsapp`, `whatsapp_recent`), `src/coordinator/tools/types.ts` (`ToolContext.whatsapp`), `src/coordinator/agent.ts` (tool registration, channel prompt), `src/coordinator/index.ts` (`createWhatsApp`, `companyWhatsApp`, `channelConversation`, request routing); reuses `src/coordinator/channels/telegram.ts` (`splitForTelegram`) and `src/coordinator/voice/speech.ts` (`parseYesNo`) | The socket, the agent runs and the approvals live in the utility process, which has no `electron` import |
| main | `src/main/settings.ts` (merge stored `whatsapp` over the defaults) | Settings persistence is main's job |
| renderer | `src/renderer/src/components/SettingsDialog.tsx` (`WhatsAppTab`), `src/renderer/src/components/Sidebar.tsx` (channel icon), `src/renderer/src/lib/format.ts` (tool labels), `src/renderer/src/lib/state.ts` and `src/renderer/src/App.tsx` (status state) | A view of the status event; no logic beyond display |

No new arrow breaks the layer rules: the channel receives everything through `WhatsAppDeps`; nothing imports the renderer or main.

## 3. Contracts
- `WhatsAppSettings = { enabled: boolean; agentId: string; threadId: string | null }`.
- `WhatsAppStatus = { state: 'off' | 'connecting' | 'qr' | 'online' | 'error'; qr?: string; number?: string; error?: string }`.
- Requests: `{ method: 'whatsapp.status' }` returns the status, `{ method: 'whatsapp.logout' }` unlinks; company variants `company.whatsapp.status` / `company.whatsapp.logout`.
- Events: `{ type: 'whatsapp.status'; status }`, `{ type: 'company.whatsapp'; companyId; status }`.
- `WhatsAppChannel`: `sync()`, `logout()`, `currentStatus()`, `resolve(to): Promise<{ jid; label }>`, `send(jid, text)`, `recentMessages(from?, limit?): RecentMessage[]`; `RecentMessage = { chat; from; text; at }`; `phoneDigits(text): string`.
- Tools (schemas in `src/coordinator/tools/whatsapp.ts`):
  - `send_whatsapp` — `ToolRisk` `publish`, standalone; input `{ to: string (min 2), text: string (1–4000) }`; has a `preview` ("Para: <label>").
  - `whatsapp_recent` — `ToolRisk` `read`, standalone; input `{ from?: string, limit?: int 1–100 }`.
- `ToolContext.whatsapp?: { resolve; send; recentMessages }`, present only when the channel is on for that run.

## 4. Data and persistence
- Session: Baileys multi-file auth state in `<userData>/whatsapp-auth` (a company's: `whatsapp-auth-<companyId>`), plain files; deleted on unlink or when WhatsApp reports "logged out"; kept when the channel is merely turned off.
- `settings.json`: `whatsapp: { enabled, agentId, threadId }`; settings written by older versions are merged over the defaults in `src/main/settings.ts`.
- The conversation is an ordinary thread with `channel: 'whatsapp'`.
- In memory only: names learned from contacts and push names, the last 300 received messages, ids of messages Alma sent.

## 5. Dependency injection
`WhatsAppChannel` takes `WhatsAppDeps` (`settings`, `dataDir`, optional `authDir` and `config`, `patch`, `conversation`, `ask`, `lastAnswer`, `transcribe`, `onEvent`, `respondApproval`, `onStatus`), so the coordinator builds the owner's channel and each company's with different folders and threads. The tools receive the channel through `ToolContext.whatsapp`; tests of the tools hand a fake with `resolve`, `send` and `recentMessages`. Pure helpers (`phoneDigits`) are exported and tested directly; the Baileys socket itself is not faked.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1–1.6, 2.1–2.4 | [gap] | logged-out close, exception before the socket, version fetch fails |
| AC-1.7 | [manual] enable, scan, check "Conectado · +número", press "Desvincular este dispositivo", check the phone and the new QR | |
| AC-2.5 | [manual] toggle the tab and read the badge and the warning | |
| AC-2.6 | [gap] | settings from an older version |
| AC-3.1–3.10, 3.13 | [gap] | own mark, own message ids, messages older than 2 minutes, status broadcasts, media without caption |
| AC-3.11 | [gap] | deleted agent falls back to the default |
| AC-3.12 | [manual] write to "Mensajes para mí" and look at the sidebar | |
| AC-4.1–4.5 | [gap] | neither yes nor no, approval of another conversation, resolved from the app |
| AC-5.1, 5.2b–5.14 | [gap] | numbers without WhatsApp, several matching contacts, input shorter or longer than allowed, channel not online |
| AC-5.2 | `tests/integrations.test.ts` → `keeps only the digits of a phone number` | formats with spaces, plus and dashes |

## 7. Security and privacy impact
- `send_whatsapp` is `publish`: asks on every call whatever the approval mode, no "Siempre" option, boss review first inside a company; only the "blocked" mode denies it outright. There is no rate limit or allowlist; the per-message approval is the guard.
- `whatsapp_recent` is `read` and needs no approval: third parties' text (groups included) goes to the model provider and is untrusted input, labelled as external data in the output.
- Alma handles no password; the session is plain files (R-04), the unofficial protocol can get the number suspended (R-05), prompt injection through messages is R-11 — all in `docs/security/RIESGOS.md`.
- The channel never writes unprompted, never answers non-owner chats and ignores synced history.

## 8. Rollout
Off by default (`enabled: false`, agent `general`, no thread). Turning it on in Configuración → WhatsApp starts the socket and shows the QR; turning it off closes the socket and keeps the session. A company's own number is a separate flag on the company.
