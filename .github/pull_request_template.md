## What and why
<!-- One or two lines. Link to the spec if it is a feature: .specify/specs/NNN-slug/spec.md -->

## Pipeline path
- [ ] **Feature** — spec `NNN-slug` in state `ready`/`implemented`, with no Open Questions
- [ ] **Fix** — a regression test that failed before the fix (Clause II)
- [ ] **Chore/docs** — no change of behavior

## Verification
- [ ] `pnpm run check` green locally
- [ ] Each AC of the spec is named in a test (`AC-n.n`)
- [ ] `tester` (against the spec) and `quality-checker` (against the architecture) ran separately
- [ ] If it touches security/privacy: I updated `docs/security/CONTROLS.md` / `RISKS.md`
- [ ] If there is no test: I justified it with `[no-tests: reason]` below

<!-- Broken gate that let this through (Clause II): which gate did you strengthen? -->
