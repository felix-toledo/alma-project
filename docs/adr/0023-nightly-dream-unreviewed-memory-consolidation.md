---
status: accepted
---

# The nightly dream rewrites the always-injected memory without review, as a fixed pipeline, caught up instead of woken

Spec [033](../../.specify/specs/033-nightly-dream-and-morning-greeting/spec.md) adds an opt-in nightly pass (the **Dream**) that rereads the conversations not yet dreamt and adds, replaces and removes lines of `Alma/Recuerdos.md`, the file injected into every system prompt. The owner decided it writes **without review** (033 BR-3), that it is a **fixed pipeline with no tools** (coordinator code reads, the model returns Zod-validated structured output, coordinator code writes; BR-15), and that a night missed because the PC slept or was off is **caught up** at the next start or resume, with no OS wake timer (BR-11). Each replaced or removed line is kept verbatim in a dated journal note with its sources, which is the only way back.

Status is `accepted` (2026-11-09): the owner accepted spec 033, and the pipeline, the service and the serialized memory writer are in the code (`src/shared/dream/`, `src/coordinator/dream/`, `src/coordinator/knowledge/base.ts`) and tested in `tests/dream-*.test.ts` and `tests/knowledge.test.ts`. The economy-model table is still empty until its list prices are confirmed (033 T5), so no dream runs in a shipped build yet.

## Why

- Memory that only grows keeps outdated facts in every prompt; a person will not review a diff every morning, which is why the owner chose no review.
- A fixed pipeline offers the model nothing to call: no approval can be asked at night, nothing can act outward in the person's name, and the only writes are the ones coordinator code makes, so the risk class stays `memory` and no new `ToolRisk` exists.
- Windows wake timers are not reliably honored under Modern Standby, and keeping the PC awake (`powerSaveBlocker`) costs power for a feature that can wait; the person's return is a better moment than a fixed hour.

## Considered options

- A review step (the person accepts a diff before memories change): rejected by the owner.
- An agent run with tools (`remember`, `forget`, `save_knowledge`): rejected by the owner (033 Q2); it would let injected text call tools and ask approvals nobody is awake to answer.
- Waking the PC at a set hour (wake timers, `powerSaveBlocker`): rejected as unreliable on Modern Standby (research report, section «Cuándo dormir»).
- Writing knowledge notes or summaries of old conversations: out (033 BR-19); only the journal and `Recuerdos.md` are written.

## Consequences

- Hard to reverse: a memory written without review shapes every later conversation until someone notices it; turning the dream off stops new writes but does not undo old ones. The journal (verbatim old lines and sources) is the undo path, by hand.
- New documented risk (`docs/security/RISKS.md`): false memories and memory poisoning by text from other people (mail, web pages, WhatsApp) read in a conversation. Mitigations: untrusted framing, no tools, read-only mode stops it, the journal is excluded from automatic recall.
- A second write path to `Recuerdos.md` besides `remember`/`forget` and the vault editor: all of them go through one serialized writer in the knowledge base, and the dream applies its changes against the snapshot it read (033 BR-20).
- Conversations are re-sent, in bulk, to the cheapest provider with a key, which may not be one the person chats with (`docs/security/PRIVACY.md`).
- Revisit by: memory lines with metadata (dates, origin, protection) would allow protected memories and a smarter merge (033 Q4); a reliable wake mechanism on Windows would allow a fixed hour.
