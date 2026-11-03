---
status: accepted
---

# The coordinator runs as an Electron utilityProcess, separate from main

Everything that thinks or does I/O for an agent (agent loop, tools, providers, channels, knowledge base, home engine, voice) lives in the **coordinator**, an Electron `utilityProcess` forked by `main` (`src/main/index.ts`, built as `coordinator.js` by `electron.vite.config.ts`). `main` keeps only windows, tray, settings, native dialogs and the Instagram session. `main` creates a `MessageChannelMain` and hands one end to the coordinator and the other to the renderer (`coordinator:port`), so the renderer talks to the coordinator directly, not through `main`.

## Why

The renderer talks to a `utilityProcess` coordinator over a direct `MessagePort`. Inference from the code: keeping agent work out of `main` keeps the window and tray responsive, and lets `tests/architecture.test.ts` forbid `electron` imports everywhere in the coordinator except `index.ts` (see [ADR 0002](0002-layer-rules-enforced-by-test.md)).

## Considered options

Alternatives: not documented.

## Consequences

- Only typed messages cross the boundary (`RequestEnvelope` / `CoordinatorMessage` in `src/shared/types.ts`). Anything `main` alone can do (safeStorage, trash, rasterizing SVG, Instagram) is a **host request** the coordinator sends to `main` and awaits.
- `main` restarts the coordinator when it exits with a non-zero code, but not when it exits with 0.
- `pnpm run dev` does not hot-reload the coordinator: restart the app after changing it (design note "integrations-design").
- `console.log` from the coordinator does not reach a redirected stdout on Windows, so debugging goes through UI events, the audit trail or a file (design note "channels-voice-design").
- A `MessagePort` between the renderer and a `utilityProcess` silently drops messages that put an `ArrayBuffer` in the transfer list; audio frames are sent copied (design note "channels-voice-design").
- Native modules used by the coordinator (`onnxruntime-node`, `sqlite-vec`) and its two worker files (`embedWorker.js`, `voiceWorker.js`) must be unpacked when packaged; packaging is still open ([spec 001](../../.specify/specs/001-release-packaging/spec.md)).
