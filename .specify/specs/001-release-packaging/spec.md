---
status: draft
---

# 001 — Release packaging

## 1. Summary
Turn a green `main` into something a person can install and update: a versioned Windows installer, produced by CI from a tag.

## 2. Problem and goal
Today the pipeline ends at `pnpm run build`, which writes `out/` for `electron-vite preview`. There is no installer, no version
policy and no way to ship a fix to anyone but the developer. Done means: pushing a `vX.Y.Z` tag produces a GitHub Release with an
installer whose contents were built from a commit that passed every gate.

## 3. Scope
**In:** installer build in CI, version source of truth, release notes, how an installed Alma learns an update exists.
**Out:** macOS/Linux builds (Alma is Windows-first: PowerShell tools, DPAPI, WSL2 for the house), app-store distribution.

## 4. Users and stories
- **US-1** As the maintainer, I want a tag to produce an installer, so that releasing is one action with no manual steps.
- **US-2** As a person using Alma, I want to install it without a dev environment, so that I can use it.
- **US-3** As a person using Alma, I want to know when a new version exists, so that I get fixes.

## 5. Acceptance criteria
- **AC-1.1** (US-1) Given a tag `vX.Y.Z` on a commit whose `ci` run is green, when the release workflow runs, then a GitHub Release `vX.Y.Z` exists with the installer attached.
- **AC-1.2** (US-1) Given a tag on a commit whose `ci` run is red or missing, when the release workflow runs, then no release is published.
- **AC-1.3** (US-1) Given a tag whose version differs from `package.json`, when the workflow runs, then it fails before building.
- **AC-2.1** (US-2) [manual] Given a clean Windows 11 machine, when the installer runs, then Alma starts and keeps working after a reboot; checked by installing in a fresh VM per release.

## 6. Business rules
None decided yet: the packager, code signing, the update channel and the versioning policy are business decisions, not defaults, and must be decided before this spec is `ready`.

## 7. Constraints and risks
- Layers touched: none in `src/`; build config, `.github/workflows/`, `package.json`.
- Security: the installer and any update channel are supply-chain surface; signing and update verification need an entry in `docs/security/CONTROLES.md` (§4 desarrollo seguro y cambios).
- Platform: native/ML modules (`onnxruntime-node`, `sqlite-vec`, `baileys`) and the bundled workers (`embedWorker`, `voiceWorker`) must be unpacked from any archive; `libsignal` is a git dependency (R-01).
