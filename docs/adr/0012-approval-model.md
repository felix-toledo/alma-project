---
status: accepted
---

# Tool calls are gated by a declared risk class and four approval modes

Every tool declares a `ToolRisk` (`read | write | exec | memory | publish | home`, `src/coordinator/tools/types.ts`) and `authorize()` in `src/coordinator/approval.ts` decides from risk and mode. Modes: «Pedir aprobación» (ask, default), «Auto-review» (a reviewer model judges each action with the person's instructions), «Permitir todo» (allow all) and «Solo lectura» (read-only). Order of decision: `read` always runs; read-only denies everything else; `memory` and `home` run; **`publish` always asks** (the boss agent reviews first in a company), ignoring every rule below; then the per-agent auto-approve list, the per-tool "Siempre permitir" ("always allow") list, then the mode. MCP tools count as `exec`. The same approval can be answered in the app, Telegram, WhatsApp or by voice; the first answer wins.

## Why

The four modes are `needs-approval`, `auto-review`, `always-allow` and `blocked`, with auto-review instructions editable and a per-rule "always allow". The "publish always asks" rule is the constitution's Clause V: a guessed answer to "what may it do without asking" is a trust and security bug; "if the right risk isn't obvious, that is an Open Question, never `read` for now". The "agents work little on their own" and "boss then user" parts for companies come from the design note "companies-design". Why `memory` and `home` skip approval: [HOME-AUTOMATION-PLAN.md](../HOME-AUTOMATION-PLAN.md) (lights, plugs and scenes are free; locks, alarms and gates always ask) and the design note "channels-voice-design" (plain reminders are created without asking).

## Considered options

Alternatives: not documented.

## Consequences

- "Permitir todo" is the widest door; switching to it needs a native confirmation dialog (`src/main/guard.ts`, see also [ADR 0013](0013-secrets-with-safestorage.md)). Adding to `alwaysAllowTools` or an agent's auto-approve list has no dialog.
- The auto-review model receives tool inputs (up to 8000 characters) and the person's latest message: a disclosure to whichever provider reviews. A reviewer error never auto-allows (it asks the person).
- Read-only also denies `memory` and `home` tools, so everyday house control stops there.
- No timeout on a pending approval; "Siempre permitir" on an MCP tool is a name-only rule across all agents.
- `fetch_url` and `web_search` are `read`, so data can leave through a URL with no approval; `send_telegram` is `memory` and never asks.
- Residual risk R-07 and R-11 (prompt injection) are accepted in [RISKS.md](../security/RISKS.md); every execution and who allowed it goes to the audit trail.
