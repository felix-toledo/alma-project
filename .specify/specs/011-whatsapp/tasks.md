# 011 — Tasks

- [x] **T1** (AC-5.2, BR-7) Test `tests/integrations.test.ts` › `keeps only the digits of a phone number` fails → implement `phoneDigits` in `src/coordinator/channels/whatsapp.ts`
- [x] **T2** (AC-2.6, BR-11) Add `WhatsAppSettings`, `WhatsAppStatus`, the `whatsapp.*` requests and events in `src/shared/types.ts`, the default in `src/shared/defaults.ts` and the merge in `src/main/settings.ts` — [gap]: no automated test yet
- [x] **T3** (AC-3.1–3.6, BR-1–BR-4) Implement the inbound filter (self chat only, own mark and ids, 2-minute staleness, status broadcasts, recent list capped at 300) in `src/coordinator/channels/whatsapp.ts` — [gap]: no automated test yet
- [x] **T4** (AC-3.7–3.10, BR-8) Implement replies (mark, 4000-character splitting, "Listo.", failure text), `/nuevo`, voice notes and caption-only media in `src/coordinator/channels/whatsapp.ts` — [gap]: no automated test yet
- [x] **T5** (AC-3.11, AC-3.13) Implement the thread creation with the chosen agent and the channel prompt in `src/coordinator/index.ts` (`channelConversation`) and `src/coordinator/agent.ts` — [gap]: no automated test yet
- [x] **T6** (AC-1.1–1.6, AC-2.1–2.4, BR-9, BR-10) Implement QR linking, unlinking, reconnection and status broadcast in `src/coordinator/channels/whatsapp.ts` — [gap]: no automated test yet
- [x] **T7** (AC-4.1–4.5) Implement approvals in the self chat (prompt text, yes/no via `parseYesNo`, resolve events) in `src/coordinator/channels/whatsapp.ts` — [gap]: no automated test yet
- [x] **T8** (AC-5.2b–5.4, BR-7) Implement `resolve` (number check on WhatsApp, learned names, ambiguity and not-found messages) in `src/coordinator/channels/whatsapp.ts` — [gap]: no automated test yet
- [x] **T9** (AC-5.5–5.9, BR-5, BR-12) Implement `send_whatsapp` with risk `publish`, preview and validation in `src/coordinator/tools/whatsapp.ts` — [gap]: no automated test yet
- [x] **T10** (AC-5.10–5.14, BR-4, BR-6) Implement `whatsapp_recent` with risk `read` and the external-data label in `src/coordinator/tools/whatsapp.ts` — [gap]: no automated test yet
- [x] **T11** (AC-5.1, AC-5.13) Wire the tools into the run: `ToolContext.whatsapp` in `src/coordinator/tools/types.ts`, registration in `src/coordinator/agent.ts`, owner and company channels and request routing in `src/coordinator/index.ts` — [gap]: no automated test yet
- [x] **T12** (AC-1.7, AC-2.5, AC-3.12) Wire the renderer: `WhatsAppTab` in `src/renderer/src/components/SettingsDialog.tsx`, the sidebar icon in `src/renderer/src/components/Sidebar.tsx`, tool labels in `src/renderer/src/lib/format.ts`, status in `src/renderer/src/lib/state.ts` — [manual]: enable, scan the QR, write to "Mensajes para mí", unlink
- [x] **T13** (BR-5, BR-10) Review `docs/security/RISKS.md` (R-04, R-05, R-11) so it describes the plain session folder, the unofficial protocol and the untrusted message text — [manual]: read the entries against the channel
