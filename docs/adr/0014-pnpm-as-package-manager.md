---
status: accepted
---

# pnpm is the package manager; npm is never used

`pnpm-lock.yaml` is the lockfile in force. Scripts, hooks and CI call `pnpm` (CI installs pnpm 12 with `pnpm/action-setup@v4` and runs `pnpm install --frozen-lockfile`). `npm install` and `npm audit fix` are forbidden because they rewrite `node_modules` with npm packages (a mixed tree) and regenerate a huge lockfile.

## Why

Design note "package-manager-pnpm": during the hardening, `npm audit fix` overwrote `node_modules` and the lockfile had to be reverted; reinstalling with `pnpm install --frozen-lockfile --force` fails on `pino` if the app is open (files locked on Windows). Why pnpm was chosen over npm in the first place: Rationale not documented.

## Considered options

Alternatives: not documented.

## Consequences

- `package-lock.json` is obsolete but still in the repo, and `package.json` has no `packageManager` field, so `npm install` would resolve versions other than the tested ones (R-10, open and trivial; [RISKS.md](../security/RISKS.md)). `README.md` still says `npm install` / `npm run dev` ([development.md](../development.md) uses pnpm).
- Re-resolving the tree fails with `ERR_PNPM_EXOTIC_SUBDEP` because `baileys` brings `libsignal` from git ([ADR 0010](0010-whatsapp-via-baileys.md)). Turning off `blockExoticSubdeps` is a decision for the user and has not been taken. This blocks the dependency upgrades of R-01 (Electron, `nodemailer`, transitive packages). The CI `audit` job is informational for that reason.
- `node_modules` is a mixed npm/pnpm tree today. `pnpm add` can fail with "Acceso denegado" when directories are in use (TS server or Alma open); close both first. Dependencies can be changed without touching `node_modules` with `pnpm add … --lockfile-only` (design note "sdd-pipeline-design").
- New npm dependencies are pinned to versions at least two weeks old (several were published the same day; design note "integrations-design").
