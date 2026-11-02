---
status: draft
---

# NNN — Title

<!--
status: draft       open questions allowed; no plan.md / tasks.md yet
        ready       no unchecked open questions; plan and tasks may exist
        implemented plan.md and tasks.md exist, every task is checked, no open questions. Each AC must either cite a
                    real test, `Test: tests/x.test.ts › "title fragment"` (or be named in a test), or carry [gap]
                    (testable but untested: debt that only shrinks) or [manual] (UI/hardware, checked by hand).
tests/specs.test.ts enforces this. Copy this file to .specify/specs/NNN-slug/spec.md.
-->

## 1. Summary
One paragraph a stranger could read: what changes for the person using Alma.

## 2. Problem and goal
What hurts today, and what is true when this is done. No solution here.

## 3. Scope
**In:**
**Out (and why):**

## 4. Users and stories
- **US-1** As <who>, I want <what>, so that <why>.

## 5. Acceptance criteria
Observable behavior, one id each. `tester` reads only this section and §6.
Tests name the id: `it('AC-1.1 …')`. Tag a criterion `[manual]` only if it cannot be automated, and say how it is checked.

- **AC-1.1** (US-1) Given <state>, when <action>, then <observable result>.
- **AC-1.2** (US-1) Given <failure: empty, malformed, offline, aborted, denied>, when <action>, then <result>.

## 6. Business rules
Rules the code must obey, each written once, each citable. If a rule is not here, it is an open question, not an `if`.

- **BR-1** …

## 7. Constraints and risks
- Layers touched (see `docs/architecture.md`):
- Security / privacy: tool risk class, new secrets, new third party, new stored personal data (→ update `docs/security/`):
- Performance / platform (Windows paths, offline, size limits):

## 8. Open Questions
Unchecked items block `ready`. Check one only when the answer is written into §5/§6 (and `docs/context.md` if it names a domain term).

- [ ] Q1 …
