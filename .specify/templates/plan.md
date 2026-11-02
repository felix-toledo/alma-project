# NNN — Plan

<!-- Written only once spec.md is `ready`. Contracts and signatures, never logic. -->

## 1. Approach
Two or three sentences: the shape of the solution and the alternative rejected (link an ADR in `docs/adr/` if it is hard to reverse).

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | | pure logic / types used by more than one layer |
| coordinator | | |
| main | | |
| renderer | | |

No new arrow may break the layer rules in `docs/architecture.md`.

## 3. Contracts
Types, Zod schemas, IPC messages, tool definitions (name, `ToolRisk`, input schema). Signatures only.

## 4. Data and persistence
What is stored where (`%APPDATA%\Alma\…`, vault, SQLite), migration of existing data, what happens to files written by the previous version.

## 5. Dependency injection
What the new code receives through `ToolContext` / constructor arguments, and what the tests fake.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1 | `tests/x.test.ts` → `AC-1.1 …` | empty, malformed, aborted … |

Pure logic extracted from UI goes to `src/shared` and is tested there.

## 7. Security and privacy impact
Risk class of each new tool, approval behavior, secrets, third parties, docs in `docs/security/` to update.

## 8. Rollout
Feature flag or setting, default value, how to turn it off, what the user sees on first run.
