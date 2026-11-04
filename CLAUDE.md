# Alma — instructions for agents

Electron desktop app (Windows): agents with local tools, channels (Telegram, WhatsApp, voice), a knowledge vault and home automation. Glossary: [docs/context.md](docs/context.md).

**The constitution rules**: [.specify/memory/constitution.md](.specify/memory/constitution.md). If anything here contradicts it, it wins.

## How we work

SDD + test first for the logic. Full route and gates: [docs/pipeline.md](docs/pipeline.md). Layers and where each thing goes: [docs/architecture.md](docs/architecture.md).

- Feature → `/feature <idea>`: spec → clarify → plan → tasks → implement → verify. No business rule is guessed: it goes to Open Questions.
- Bug → `/fix <bug>`: a failing test, a minimal fix, and strengthening the gate that let it through.
- Chore (docs, deps, a rename with no change of behavior): directly.
- Agents in `.claude/agents/`: `router`, `planner`, `implementer`, `tester`, `quality-checker`. Specs in `.specify/specs/`.

## Commands

```bash
pnpm run check        # lint + typecheck + tests with coverage + test policy (the same as CI)
pnpm run check:fast   # without coverage (what the hook runs when finishing)
pnpm run lint         # Biome
pnpm run test         # Vitest (includes architecture and specs)
pnpm run dev          # app with reload
```

- **pnpm always.** Never `npm install` or `npm audit fix`: they break `node_modules`. If pnpm fails because of locked files, close Alma and the editor.
- Never `--no-verify`, nor `biome-ignore` without a written reason, nor lowering a threshold (Constitution II).
- Commits `type(area): summary` (feat, fix, refactor, test, docs, chore, ci, perf, build). **No** Claude `Co-Authored-By`.

## Short rules

- Layers: `shared` ← `main`, `coordinator`, `renderer`; nobody imports sideways. `electron` only in `main/` and `coordinator/index.ts`. `tests/architecture.test.ts` checks it.
- New logic = a new test, seen to fail first. Each AC of a spec is named in a test (`AC-1.1`).
- Every tool declares its `ToolRisk`; what acts outward on the user's behalf is `publish` (always asks). Doubts about risk → Open Question.
- Secrets only encrypted (`safeStorage`); never in logs, errors, fixtures or prompts.
- Security or privacy changes update `docs/security/` in the same PR.
- UI: load the `console-ui` and `umbra-ui` skills before touching JSX or CSS.
- Style: match the neighboring code (no `;`, single quotes, identifiers in English, user-facing text through the dictionaries in `src/shared/i18n` (Spanish and English), comments only for the why). Commit messages, docs, skills and code comments are English.
