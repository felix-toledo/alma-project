---
status: accepted
---

# Layer rules are enforced by a test, not by convention

`shared` is a leaf; `renderer`, `main` and `coordinator` never import each other; only `src/coordinator/index.ts` touches `electron`; the renderer imports no `node:*`, no `electron` and no node-only shared module (`shared/audit`). The rules are data in `tests/support/arch.ts` (`RULES`), checked on every `pnpm run test` by `tests/architecture.test.ts`, and each rule has a negative fixture so it cannot pass empty. Biome adds `noImportCycles` as an error (`biome.json`).

## Why

Documented in the constitution, Clause IV: without separation every tool grows its own copy of policy and I/O, nothing is unit-testable, and the process boundary (what may touch the network, the disk, the OS) blurs. The pipeline doc adds the general principle: when a prose rule is broken twice, it becomes a sensor ([pipeline.md](../pipeline.md), "Guías, sensores y compuertas humanas"). Relaxing a rule must be discussed first (constitution II); see [architecture.md](../architecture.md) section 2.

## Considered options

Alternatives: not documented.

## Consequences

- The renderer has no component-test harness, so any logic with a rule in it must be extracted to a pure function in `src/shared` and tested there.
- Dependencies reach tools through `ToolContext` / `Host`, not singletons; this is what lets tests pass doubles.
- The rules only look at import specifiers. `src/preload` has no rule of its own in `RULES` (inference from reading the list; confirm before relying on it).
- Adding a rule means a new `RULES` entry plus a fixture that breaks it.
