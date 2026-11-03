---
status: accepted
---

# Biome is used as a linter only; there is no auto-formatter yet

`biome.json` has `formatter.enabled: false` and `organizeImports` off. Biome errors block (`pnpm run lint` uses `--diagnostic-level=error`); the existing warnings are tracked debt (`pnpm run lint:debt`) that is lowered gradually, and the list of rules downgraded to `warn` may be tightened, never loosened (constitution II). Style is "match the neighboring code" (no semicolons, single quotes).

## Why

[pipeline.md](../pipeline.md), "Deuda conocida": 141 files are not uniformly formatted. The plan is to run Biome format in a separate commit and only then add it to `check`. The design note "sdd-pipeline-design" says the same: format in a separate commit, then add it to the gate. Why Biome over another linter: Rationale not documented.

## Considered options

Turning the formatter on from the start is implied but not recorded as rejected. The documented plan is "format later, in its own commit" (so a 141-file reformat does not bury feature changes). Alternatives: not documented.

## Consequences

- No formatting gate: `docs/architecture.md` section 3 says style is by example and Biome only flags the obvious. Reviews can still see formatting noise.
- The warning count (548 at the time of writing in pipeline.md) comes mostly from accessibility, non-null assertion and comma warnings. The `a11y` group and `noNonNullAssertion` are set to `warn` in `biome.json` (debt, not blockers).
- `noFloatingPromises` and `noImportCycles` are errors; `biome-ignore` needs a written reason.
- Revisit by: running `biome format --write` in one commit, then enabling the formatter and adding it to `check` (not done).
