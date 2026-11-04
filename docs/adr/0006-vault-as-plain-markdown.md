---
status: accepted
---

# The vault is a folder of plain Markdown files

The source of truth for the person's notes and for what Alma learns is real `.md` files in a vault folder that any Markdown editor can open. Alma's own writing lives inside it: `Alma/Recuerdos.md` (one memory per line) and `Alma/Conocimientos/*.md` (frontmatter `origen: ia`). Everything else (the SQLite index, [ADR 0003](0003-sqlite-fts5-sqlite-vec-index.md)) is disposable. Drawings are plain `.excalidraw` files.

## Why

Design note "vault-knowledge-design": the user wants local-first notes in plain Markdown; an existing folder of notes can be opened later as a second vault. There is one global active vault for all conversations; the per-conversation working folder stays separate.

## Considered options

Alternatives: not documented.

## Consequences

- Files can be edited by any program; a folder watcher re-scans after a 400 ms quiet period. Hidden (dot) folders such as `.git` are never indexed or readable by tools.
- All vault paths are confined to the vault root; the note says the previous ALMA monorepo had a `..` traversal plus recursive delete bug, so confinement is deliberate ([spec 009](../../.specify/specs/009-knowledge-and-memory/spec.md) AC-8.4).
- Memories are Markdown bullets; any bullet in `Recuerdos.md` counts as a memory and is rewritten on the next `remember`/`forget`.
- Notes and memories live outside the data folder that "export my data" and erase cover; the vault is also in plain text on disk (R-04 in [RISKS.md](../security/RISKS.md)).
- Not built yet, per the note: wikilinks/backlinks and a graph view.
- Excalidraw cannot measure text inside the coordinator (no canvas), so agent drawings are queued as ops in the file and applied by the window when it opens it.
