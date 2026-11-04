# Constitution — Alma

Non-negotiable principles for this project. No agent, human or model may skip
them "to go faster." If a plan or a task tenses against a clause, the tension
gets resolved here, in writing — not in the code.

> This constitution was first written for a multi-service
> web system (services, Prisma, Postgres, MCP server, Next.js). Alma is an
> Electron desktop app with three layers (`main`, `coordinator`, `renderer`)
> plus `shared`, so Clauses III–V were rewritten for the code that actually
> exists. Clause I is domain-agnostic and unchanged; Clause II only gained the
> ratchet rule and Biome naming.

This file outranks `CLAUDE.md`, any agent's instructions, and any loose
instruction in chat. If something conflicts, the constitution wins, and the
reason is stated explicitly.

---

## I. Spec as Source of Truth

No business rule is ever guessed.

- If `planner` (or any agent) can't find a business rule written explicitly
  in the spec, **it doesn't infer it or copy it from a similar case** — it
  writes it into the spec's "Open Questions" section and leaves it pending a
  human answer.
- A spec with unanswered Open Questions **does not advance** to Plan, and
  those questions **are never answered in code** (i.e., "resolving" an
  ambiguity by writing the `if` that seemed reasonable and moving on is
  forbidden).
- Code is never the source of truth for a business rule. The spec is. If code
  and spec disagree, the spec wins (or the spec gets corrected, explicitly,
  with a human in the loop).

**Why**: a guessed business rule is a bug wearing a feature's clothes —
doubly so once Alma holds a person's private notes, messages, cameras and
credentials, where a guess about "what may it do without asking" becomes a
trust/security bug instead of a UX nitpick.

**Enforced by**: `tests/specs.test.ts` fails if a `ready` or `implemented`
spec still has an unchecked Open Question, or if a `draft` spec already has a
plan or tasks.

## II. Encode Every Correction

If an error slips through a gate (lint, test, typecheck, human review), the
fix isn't just fixing the symptom — it includes strengthening the gate that
let it through.

- A bug that breaks an already-documented rule → add or reinforce the test
  that makes it impossible next time.
- A pattern lint doesn't catch → add or adjust a lint rule.
- A type too loose to have prevented the error → narrow the type.
- Naming the gate that was added/reinforced is part of reporting the
  correction — not optional, not a "nice to have" for later.
- A gate is never disabled just to get a green build. If a gate is
  legitimately in the way, it gets discussed and adjusted with the human, not
  bypassed with `--no-verify`, an unjustified `biome-ignore`, or a skip.
- Ratchets only go one way: the coverage thresholds in `vitest.config.mts`
  and the list of rules downgraded to `warn` in `biome.json` may be tightened,
  never loosened.

**Why**: without this, the team (human + agents) relearns the same mistake
every few weeks. Every correction should leave the system structurally harder
to break the same way twice.

## III. Spec-Driven Development with Test-First Logic

The methodology is **SDD**: scope and sequencing come from the spec's
pipeline
(`Constitution → Specify → Clarify → Plan → Tasks → Implement → Verify → Ship`,
see [`docs/pipeline.md`](../../docs/pipeline.md)), and **pseudo-TDD** inside
Implement: logic is written test-first; glue and UI are not dogmatically so.

- **Three paths by size** (`router` picks, the human can overrule):
  *Feature* takes the whole pipeline. *Fix* writes a regression test that
  fails first, then the fix (Clause II). *Chore* (docs, deps, rename with no
  behavior change) needs neither spec nor new test.
- **Logic is test-first.** In `src/coordinator`, `src/shared` and `src/main`,
  a task starts with a failing Vitest test, seen failing **for the right
  reason** (not a bad import), then the minimum code, then refactor.
- **Every Acceptance Criterion ends up covered.** Tests name the criterion
  they verify (`it('AC-2.1 …')`). `tests/specs.test.ts` fails for an
  `implemented` spec if an `AC-n.n` cites no test, is named in no test and carries no `[gap]` or `[manual]` tag. A criterion that can
  only be checked by hand carries `[manual]` and names how in the spec.
- **A criterion without a test is visible debt.** An `implemented` spec cites the test that covers each criterion
  (`Test: tests/x.test.ts › "title"`) or tags it `[gap]` (testable, no test yet) or `[manual]`; the `[gap]` list only
  shrinks (see `.specify/specs/README.md`).
- **Logic cannot change without tests changing.** `scripts/require-tests.mts`
  (pre-push and CI) rejects a diff that touches logic and no test, unless a
  commit or the PR body says `[no-tests: <real reason>]`.
- **Coverage is a ratchet**, not a target to game: `vitest.config.mts` holds
  the floor; a drop means new code arrived without tests.
- **Pure logic leaves the UI.** The renderer has no component-test harness
  (typecheck + lint + a manual run via the `run` skill cover it). Anything
  with a rule in it — parsing, filtering, state machines, formatting a
  decision — is extracted to a pure function in `src/shared` and tested there.
- `implementer` cannot mark a task done without its test passing and
  `pnpm run check:fast` green.
- `tester` writes tests to break the system, not to confirm the happy path
  (empty state, malformed input, provider or network failure, aborted run,
  denied approval, Windows paths and CRLF, size limits).
- A test that has never been seen to fail proves nothing. Add it, then run it
  against the pre-fix or a deliberately broken version (the checkers under
  `tests/` do this with negative fixtures — follow that pattern).

**Why**: "works in my manual test" isn't sufficient evidence for a system
that acts on a person's behalf. The test is the executable contract; the spec
is what the contract is a contract *of*.

## IV. Layer Separation

Strictly as in [`docs/architecture.md`](../../docs/architecture.md):

```
renderer ──IPC──▶ main ──messages──▶ coordinator      (nobody imports sideways)
      ╲             │                     │
       └──────────▶ shared ◀──────────────┘            (shared imports nothing)
```

- `src/shared` is a leaf: types, schemas and pure functions used by more than
  one layer. It imports none of `main`, `coordinator`, `renderer`, `preload`.
- `src/renderer` never imports `main`/`coordinator`, nor `electron`, nor
  `node:*`, nor node-only shared modules (`shared/audit`).
- `src/coordinator` never imports `main`/`renderer`, and only
  `coordinator/index.ts` (the process entrypoint) touches `electron`.
- `src/main` never imports `coordinator`/`renderer`.
- **Functional core, imperative shell.** Decisions live in pure, exported,
  tested functions (see `src/main/guard.ts`, `src/coordinator/tools/web.ts`
  `isPrivateHost`); I/O sits in thin shells around them.
- **Dependencies are injected, not reached for.** A tool receives what it
  needs through `ToolContext` / `Host` (workspace, settings, signal, the
  vault, Telegram, WhatsApp, the house). It does not import a singleton or
  read global state. This is what lets `tester` fake it.
- **Validate at the boundary** with Zod: tool inputs, IPC payloads, settings
  read from disk, anything from the network. Inside the boundary, trust types.
- When behavior varies by provider or channel, use a strategy (see
  `providers/`), not a growing `if/else` in the caller.

**Why**: without separation, every tool grows its own copy of policy and I/O,
nothing is unit-testable, and the process boundary (what may touch the
network, the disk, the OS) blurs.

**Enforced by**: `tests/architecture.test.ts` (layer rules, with negative
fixtures) and Biome's `noImportCycles`.

## V. Security and Privacy by Construction

Alma holds API keys, messages, notes, camera feeds and can run commands.
Controls are documented in [`docs/security/`](../../docs/security/CONTROLS.md).

- **Every tool declares a `ToolRisk`** (`read | write | exec | memory | publish | home`)
  and goes through the approval policy accordingly. A tool that acts on the
  outside world in the user's name is `publish`: the user approves every call.
  If the right risk isn't obvious, that is an Open Question (Clause I), never
  `read` "for now".
- **Secrets** are only stored encrypted (`safeStorage`) and never appear in
  logs, audit entries, error messages, test fixtures or prompts.
- **Anything that makes Alma execute new code** (an MCP stdio server, a
  command, a changed environment) is confirmed by the person in a native
  dialog the page cannot click (`src/main/guard.ts`).
- **Local network and private hosts stay off-limits to web tools** unless a
  spec explicitly opens them.
- A change that adds attack surface, a data flow to a new third party, or a
  new category of stored personal data updates `docs/security/CONTROLS.md`,
  `RISKS.md` or `PRIVACY.md` **in the same PR**.

**Why**: a bug in a chat app is annoying; a bug in an agent with keys, a
shell and a camera is an incident.

---

## Precedence

`Constitution` > `CLAUDE.md` > active spec > `docs/architecture.md` and
`docs/pipeline.md` > relevant skill > in-the-moment style preference.

If an agent detects it can't complete a task without violating a clause, it
stops and reports it — it doesn't pick whichever clause is most convenient to
break.
