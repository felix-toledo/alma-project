---
description: Fix a bug test-first and harden the gate that let it through
argument-hint: <the bug: what you saw vs what you expected>
---

Bug: $ARGUMENTS

Constitution II applies. In order:

1. Find the root cause (read every caller of the code involved, do not patch only the reported path).
2. Write a Vitest test that reproduces it. Run it and confirm it **fails for the right reason**.
3. Make the smallest fix that turns it green. Run `pnpm run check:fast`.
4. Name the gate that let this through (missing test, loose type, lint rule, spec gap) and strengthen it: widen the test,
   narrow the type, or add the rule. If a business rule was never written down, open a spec instead of inventing one.
5. Report: root cause, test added, gate reinforced.
