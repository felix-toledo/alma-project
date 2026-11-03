---
status: proposed
---

# Names Alma writes follow the language; an existing name always wins

Alma writes files and folders with fixed names (`Alma/Recuerdos.md`, `Alma/Conocimientos/`, `Reuniones/…`, `biblioteca/`, `paletas.json`, `recetas.json`, the frontmatter key `origen: ia`). With the app language changing live ([spec 025](../../.specify/specs/025-i18n-es-en/spec.md) BR-23), these names follow `language` for new files only. When Alma reads or writes, if a file or folder exists under either language's name, that one is used and nothing is renamed or duplicated; if both exist the current language's is used; only when none exists is it created under the current language's name. The human chose that names follow the language and delegated the rule for existing files ("fijate entonces que conviene en esto").

Status is `proposed`: it becomes `accepted` once the rule is in the code.

## Why

A language change must never hide existing memories or notes. Renaming on change would break links between notes and any other tool reading the vault; looking only under the current name would make `Recuerdos.md` appear empty after a switch.

## Considered options

- Keep Spanish names forever (identifiers): rejected by the human ("sigue el idioma").
- Rename or migrate existing files on a language change: not chosen; it was offered as an option and the delegated choice was "existing wins", never renamed.
- Recognize only the current language's name: not chosen, same reason as above.

## Consequences

- Every place that opens one of these names must look under both languages' names first; this is one small pure function plus a test per name.
- A vault can end up with Spanish names written by an earlier language and English names for newly created files; the two never merge.
- The tie-break when both names exist (current language wins, the other is untouched) was chosen under the delegation, not by an explicit answer.
- Revisit by: a migration tool that merges or renames, if people end up with both sets of files.
