---
status: accepted
---

# The knowledge index is one SQLite file per vault: node:sqlite + FTS5 + sqlite-vec

The search index over a vault is a single SQLite database per vault at `<userData>/knowledge/<id>.db` (WAL mode), opened with the built-in `node:sqlite` (`DatabaseSync`), using FTS5 for keywords (BM25) and the `sqlite-vec` extension for vector KNN (`src/coordinator/knowledge/db.ts`). The index only mirrors the files: it is disposable and rebuilt from the vault ([ADR 0006](0006-vault-as-plain-markdown.md)).

## Why

From the design note "vault-knowledge-design": `node:sqlite` is built into Electron 44 / Node 24.21, a spike verified it works together with `sqlite-vec` 0.1.9 and FTS5 with **no native rebuild**, and Orca (stablyai/orca, MIT) uses `node:sqlite` the same way. The note also says the stack was chosen because the user asked for local-first and "fully optimized".

## Considered options

Alternatives: not documented. Inference: the stress on "no native rebuild" suggests bindings that need rebuilding per Electron version were the concern.

## Consequences

- `DatabaseSync` is synchronous: queries run on the coordinator's thread. Embeddings are kept off it ([ADR 0004](0004-bge-m3-int8-cpu-worker-thread.md)).
- `node:sqlite` extension loading plus `sqlite-vec` are native and must be unpacked when the app is packaged ([spec 001](../../.specify/specs/001-release-packaging/spec.md)).
- The vault id is the first 16 hex characters of the SHA-1 of the lowercased vault path, so moving or renaming a vault folder starts a fresh index (and re-embeds everything).
- If the embedding model id changes, all vectors are dropped and every chunk is marked pending again.
- A company's vault gets its own `.db` in the same folder and shares one embedder instance.
- The `node:sqlite` API is part of Node; its stability level is a Node concern, not documented here.
- Details and known gaps: [spec 009](../../.specify/specs/009-knowledge-and-memory/spec.md).
