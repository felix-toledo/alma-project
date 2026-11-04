---
status: accepted
---

# Typed dictionaries in `src/shared`, no i18n library

Alma needs to speak Spanish and English everywhere ([spec 025](../../.specify/specs/025-i18n-es-en/spec.md)). The proposal from the maintainer: two typed dictionaries (`es.ts`, `en.ts`) in `src/shared/`, a `useT()` hook in the renderer, and no i18next. `shared` is the leaf every layer may import, so `main` and the coordinator read the same dictionaries as the renderer without breaking the layer rules ([architecture.md](../architecture.md)). A key-parity test and a ratchet against hardcoded JSX text keep both languages complete.

Status is `accepted` for the dictionary design only (typed `es`/`en` files in `src/shared/i18n`, `translate`, the parity test and the ratchet), which spec 025 implements. The reason for not using i18next stays 'not documented'.

## Why

Given by the maintainer: no library, typed dictionaries, parity test, ratchet. Why i18next is not wanted: Rationale not documented; the human confirms it when approving the spec.

## Considered options

- i18next (and similar libraries): named by the maintainer as not wanted. Other alternatives: not documented.

## Consequences

Expected, not yet verified:

- A new user-visible string is added to both files; the type checker rejects an unknown key and the parity test rejects a one-sided key.
- The language changes live (spec 025 BR-13), so the renderer hook must re-render every consumer when `language` changes; there is no reload to hide a stale string.
- No runtime language packs or lazy loading; both dictionaries ship in the bundle, so Alma works offline.
- Parameters and plural wording are handled by Alma's own small pure function in `shared` (spec 025 BR-10, AC-2.6), instead of a library's ICU support.
- Adding a third language means a third dictionary file plus the parity gate; the `language` setting type and the voice stack (spec 025 Q8) are the other places that would change.
- Revisit by: moving the resolver behind a library if plural or locale rules outgrow the hand-written function.
