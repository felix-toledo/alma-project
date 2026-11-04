# Pipeline: from asking for a feature to production

How we work from now on. The authority is the [constitution](../.specify/memory/constitution.md); this page gives the route and which gate stops you at each stretch.

You start with `/feature <idea>` (or `/fix <bug>`). The `router` agent looks at the real state of the repo and decides the path.

```
 idea
  │
  ▼
router ──▶ size?
  │
  ├─ FEATURE  (new or changed behavior, tool, channel, setting)
  │     Specify ─▶ Clarify ─▶ Plan ─▶ Tasks ─▶ Implement ─▶ Verify ─▶ PR ─▶ CI ─▶ main ─▶ Release
  │     planner    planner    planner  planner  implementer  tester ∥        human
  │               +grill-with-docs                          quality-checker
  │        ▲ ─── human approves the spec (`ready`) ───┘
  │
  ├─ FIX      (something documented or obvious is not met)
  │     test of the regression that FAILS ─▶ minimal fix ─▶ Verify ─▶ PR … ─▶ + strengthen the gate that let it through
  │
  └─ CHORE    (docs, dependencies, a rename with no change of behavior) ─▶ PR …
```

## Stages

| # | Stage | Who | Produces | What stops it |
|---|---|---|---|---|
| 1 | Triage | `router` | chosen path (feature / fix / chore) | — |
| 2 | Specify | `planner` | `.specify/specs/NNN-slug/spec.md` (`status: draft`) with stories, AC and rules | incomplete template |
| 3 | Clarify | `planner` + skill `grill-with-docs` | Open Questions answered; new terms in `docs/context.md`; ADR if it is hard to reverse | **`tests/specs.test.ts`**: a `ready` spec with an open question, or a `draft` with a plan, fails |
| ◆ | **Human gate 1** | you | spec in `status: ready` | nobody moves on without this |
| 4 | Plan | `planner` | `plan.md`: layers touched, contracts, AC→test strategy | layer rules (`docs/architecture.md`) |
| 5 | Tasks | `planner` | `tasks.md`: one task = one failing test + minimal code | — |
| 6 | Implement | `implementer`, one task at a time | red test → code → green → refactor | edit hook (Biome on the file), finish hook (`check:fast` if anything changed), `require-tests` |
| 7 | Verify | `tester` ∥ `quality-checker`, separately | `tester`: a verdict per AC looking only at the spec; `quality-checker`: architecture and cleanliness looking only at the code | the findings go back to `implementer` |
| 8 | PR | you / agent | branch `feat/…` or `fix/…`, commits `type(area): summary`, PR template filled in | pre-commit, commit-msg, pre-push (`pnpm run check`) |
| 9 | CI | GitHub Actions | `quality`, `verify` (and an informational `audit`) | any red one |
| ◆ | **Human gate 2** | you | merge to `main` | review; branch protection (see pending items) |
| 10 | Release | see spec [001](../.specify/specs/001-release-packaging/spec.md) | today: `pnpm run build` and a tag by hand. Tomorrow: tag → installer | — |

`tester` and `quality-checker` do not talk to each other or read the `implementer`'s reasoning: each one judges only from its own source, so that neither approves what the other looked at fondly.

## Sizes: when a spec is NOT needed

A process that stops everything gets abandoned. Rule of thumb:

- **Feature** if a user notices something different or there is a rule someone could argue about. Full spec.
- **Fix** if the behavior contradicts something already documented or is obvious. No spec: a failing test, the fix, and naming the gate that was strengthened (Constitution II). If the bug shows that a written rule was missing, a separate spec is opened.
- **Chore**: no spec and no new test.

When in doubt, `router` asks once and picks the shortest path that does not guess a business rule.

## Gates (sensors) and where they run

| Gate | What it catches | On edit | When the agent finishes | Commit | Push | CI |
|---|---|:-:|:-:|:-:|:-:|:-:|
| Biome (`pnpm run lint`) | bugs, unused imports, cycles, promises not awaited | file | ✔ | staged | ✔ | ✔ |
| `tsc` (`pnpm run typecheck`) | types, tests included | | ✔ | | ✔ | ✔ |
| Vitest (`pnpm run test`) | behavior + **architecture** + **specs** | | ✔ | | ✔ | ✔ |
| Coverage (`test:coverage`) | a floor that only goes up | | | | ✔ | ✔ |
| `require-tests` | logic changed without a test changed (`[no-tests: reason]` for exceptions) | | | | ✔ | ✔ (PR) |
| `commit-msg` | format `type(area): …`; no Claude `Co-Authored-By` | | | ✔ | | |
| `build` | that it compiles and packages | | | | | ✔ |
| `audit` | vulnerable dependencies | | | | | informational (R-01) |

"Silence if it passes, noise if it fails": green gates print nothing; red ones hand the error back to the agent so it corrects itself. If the agent stays red 3 times in a row with the same change, it stops blocking and tells you (this avoids loops).

Commands: `pnpm run check` (everything), `pnpm run check:fast` (no coverage), `pnpm run lint`, `pnpm run test`.

## Definition of done

1. Spec `implemented`: with `plan.md` and `tasks.md`, each AC cites its test (or is `[manual]` with how it is verified, or `[gap]` if it has none yet), no Open Questions, tasks ticked.
2. `pnpm run check` green.
3. `tester` and `quality-checker` reported with no open findings.
4. If it touched security or privacy: `docs/security/` updated in the same PR.
5. CI green and reviewed by you.

## Guides, sensors and human gates (why they exist)

- **Guides** (before acting): constitution, `CLAUDE.md`, agents with minimal tools (`router`, `planner` and `quality-checker` do not write code), templates, skills.
- **Sensors** (after acting): the table above. When a prose rule is broken twice, it becomes a sensor (that is how `architecture.test.ts` and `specs.test.ts` were born).
- **Human gates**: only where what was done is expensive to undo — approving the spec and merging.

## Known debt (on purpose, with a ratchet)

- **548 Biome warnings** (renderer accessibility, non-null `!`, commas): they do not block, but errors do. They are brought down little by little; `biome.json` is never loosened.
- **No formatter**: 141 files are not formatted uniformly; run Biome format in a separate commit and only then add it to `check`.
- **Coverage ~54 %** of lines in `coordinator`/`shared`/`main`; the floor is in `vitest.config.mts` and only goes up. The renderer has no component tests.
- **Release** not packaged: spec 001, in `draft`.

## Pending items that can only be done on GitHub

- Protect `main`: require a PR and the `quality` and `verify` checks; forbid direct pushes.
- Fill in the security email in `SECURITY.md`.
