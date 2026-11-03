---
status: accepted
---

# Work follows a spec-driven pipeline

Features go `Specify, Clarify, Plan, Tasks, Implement, Verify, PR, CI` ([pipeline.md](../pipeline.md)), with spec-driven development (SDD) plus test-first for logic. `.specify/memory/constitution.md` outranks everything else. A spec with an unanswered Open Question cannot reach Plan (`tests/specs.test.ts`). Agents have separate roles (`router`, `planner`, `implementer`, `tester`, `quality-checker` in `.claude/agents/`), and `tester` and `quality-checker` do not read each other's reasoning. Every feature has a spec, a plan and a task list in `.specify/specs/NNN-slug/`; each acceptance criterion cites its test or is tagged `[gap]` or `[manual]`.

## Why

Design note "sdd-pipeline-design": the user wanted a pipeline from idea to production with checkers, an architecture that makes sense and minimal unit tests, "not vibecoding". The agents and constitution that were brought in came from another project (services, Prisma, Next.js) and were rewritten for this Electron app. Constitution Clause I: a business rule is never guessed; it becomes an Open Question until a person answers it.

## Considered options

Alternatives: not documented. The pipeline defines three sizes (feature, fix, chore) so the process does not become one that blocks everything and gets abandoned.

## Consequences

- The `[gap]` list (criteria with no test yet) is the test backlog and only shrinks.
- Gates are ratchets (coverage floor in `vitest.config.mts`, Biome rules): they only tighten. Coverage is about 54% of lines in `coordinator`, `shared` and `main`; the renderer has no component tests.
- `scripts/require-tests.mts` rejects a diff that changes logic without changing a test (unless `[no-tests: reason]`).
- Pending human steps: branch protection on `main` (require PR and the `quality` and `verify` checks), the security contact email in `SECURITY.md`, and spec 001 (packaging and release) is still a `draft`.
- Documentation in `docs/` is a second reader-facing layer over the specs; when spec and code disagree, the code wins and the doc says so ([docs-guide.md](../../.specify/templates/docs-guide.md)).
