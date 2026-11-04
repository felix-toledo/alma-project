# Writing the human documentation

The specs in `.specify/specs/` are the contract (for tests and agents). The documents in `docs/` are for people: the
maintainer, a new contributor, a user who wants to know what Alma does. Same truth, different reader.

## Rules (all documents)

- **English, everything.** Identifiers, file names, tool names stay as in the code. Strings the app shows the user, and
  example phrases a person would say to Alma in chat, stay in their original Spanish, quoted verbatim, and are glossed in
  English the first time. Plain, short sentences; tables where they help; no marketing language.
- **Truth comes from the code and the specs.** Read the spec(s) for your area first, then verify anything you are
  not sure of in `src/`. If the spec and the code disagree, the code wins and you say so. Never describe behavior you did
  not confirm.
- **Never invent a reason.** Why something was built a certain way is only written when it is documented somewhere
  (README, `docs/HOME-AUTOMATION-PLAN.md`, `docs/security/*`, code comments, the design-note files listed in your assignment).
  Otherwise write `Rationale not documented` and, if useful, what the code suggests, labeled as inference.
- **Do not hide problems.** Known bugs and gaps go in a "Known limits" section, not in the happy-path description.
  Link the spec as `[spec 002](../../.specify/specs/002-chat/spec.md)`.
- **Never write a secret value**, only where it is stored.
- Do not edit `src/`, `tests/`, `.specify/specs/` or `package.json`. Only create/edit the files in your assignment.
- **Never run `pnpm` or `npm`** (they reinstall `node_modules` and break it). Do not start the app.
- Relative links must resolve (a test checks every link in `docs/`). From `docs/modules/x.md`: `../../.specify/specs/…`,
  `../architecture.md`, `../references/tools.md`. Link to files that exist or that are in your assignment list.
- Write the first complete draft to disk **early**, then refine with Edit, so a cut-off never loses work.
- Finish with a report of at most 10 lines: files written, anything you could not verify, anything surprising.

File and folder names stay as listed in the assignment (`docs/modules/`, `docs/references/`, `tools.md`…), even
though the content is English.

## Module document (`docs/modules/<name>.md`)

Target 120–250 lines. Exactly these sections, in this order:

```
# <Module>

> One line: what it is and what it is for. Spec(s): links. Test status: "N criteria with a test, M without".

## What it does
Capabilities seen from outside, in a person's terms. What the person can do and what an agent can do.

## How to use it
Concrete steps for the person: where it is in the app, what to click, what they see. Include how to ask Alma for it in
chat when that applies (real example phrases, in Spanish with an English gloss). Keyboard shortcuts if any.

## How it works
For whoever maintains the code: the pieces (real files in `src/`), the end-to-end flow, the messages between layers, and
an ASCII diagram if it helps. What is not obvious.

## Tools for agents
Table: name · risk (`ToolRisk`) · asks approval · purpose. Omit the section if the module exposes no tools.

## Settings and data
Which settings control it (with defaults) and where it stores data (folder, file, format).

## Limits and rules
The numbers and policies that shape behavior (caps, timeouts, sizes), with their real values.

## Security and privacy
What it asks before acting, what it blocks, what it stores, what leaves the machine and to which third party.

## How it is tested
Which tests exist (file), what is not covered, how to verify by hand what is interface.

## Known limits
Short, prioritized list of what is missing or wrong (probable bugs, gaps, debt), linking to the spec.

## See also
Neighboring modules and reference documents.
```

## Reference document (`docs/references/*.md`)

Tables first. Every row verified in code, with the source file. Alphabetical or grouped by module, said at the top.
End with the line "Written by hand from the code; when you add a row, verify the name in the code" so a
reader knows how it is maintained.
