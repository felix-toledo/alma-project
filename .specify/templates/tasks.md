# NNN — Tasks

<!--
One task = one failing test, then the minimum code. `implementer` takes one at a time, top to bottom.
Check a box only when the named test passes and `pnpm run check:fast` is green (a task for a `[gap]` criterion says so and has no test yet).
-->

- [ ] **T1** (AC-1.1) Test `tests/x.test.ts` › `AC-1.1 …` fails → implement in `src/shared/y.ts`
- [ ] **T2** (AC-1.2) Test for the failure path fails → handle it
- [ ] **T3** (BR-1) Extract the rule to a pure function, test it directly
- [ ] **T4** Wire it: tool / IPC / UI (no new logic here; typecheck + lint + manual run)
- [ ] **T5** Update `docs/security/` / README if the plan said so
