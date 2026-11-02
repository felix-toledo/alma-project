---
description: Run the SDD pipeline for a new feature, from idea to a verified, PR-ready change
argument-hint: <what you want, in your own words>
---

Feature request: $ARGUMENTS

Follow `docs/pipeline.md`. Start with the `router` agent: it inspects `.specify/specs/` and decides the stage and the size
(feature / fix / chore). Then delegate stage by stage:

1. `planner` writes `spec.md` from `.specify/templates/spec.md` and clarifies with the `grill-with-docs` skill.
2. **Stop and show me the spec.** I move it to `status: ready`. Do not plan on a spec with open questions.
3. `planner` writes `plan.md` and `tasks.md`.
4. `implementer` takes one task at a time: failing test first, then code, then `pnpm run check:fast`.
5. `tester` (spec only) and `quality-checker` (code only) verify in parallel, separately.
6. Fix findings, set the spec to `implemented`, run `pnpm run check`, and report the PR summary.

Never answer an open question yourself.
