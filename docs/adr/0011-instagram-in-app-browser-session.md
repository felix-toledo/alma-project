---
status: accepted
---

# Instagram posts are published by driving the website in an in-app browser session, with mandatory approval

The person logs in once on Instagram's real login page inside an Alma window; Alma keeps only the session cookies, in the separate Electron partition `persist:instagram`, and never sees the password. `instagram_publish` (risk `publish`) drives the Instagram website with the Chrome DevTools protocol in a visible window (`src/main/instagram.ts`) after the person approves the image and caption. **Test mode** (default on) fills in the whole post but never presses "Compartir" ("Share").

## Why

Documented in [spec 012](../../.specify/specs/012-instagram/spec.md), section 2: Instagram has no public posting API for a personal desktop tool, and handing a password to an app is unsafe; the goal is to publish without Alma seeing the password, with the person approving each post and a controlled, visible failure when Instagram changes its page. The "always asks" rule follows the constitution (Clause V: anything that acts outward in the user's name is `publish`).

## Considered options

Alternatives: not documented.

## Consequences

- Fragile by design: the automation depends on Instagram's page structure and on its English, Spanish and Portuguese texts; other languages fail at the first step. On failure the window stays open for finishing by hand.
- "Compartir" is clicked once and never retried, because a retry could publish twice. If the confirmation never appears, the result is a failure although the post may be live.
- Test mode returns `ok: true`, so a routine may log the post as published.
- Instagram may block or suspend accounts that automate; the Settings tab recommends 1 or 2 posts a day, with no rate limit in code.
- The post is approved before its image is validated; nothing stops two publishes at once.
- It needs a display and the main window, so it cannot run headless. The user agent has the `Alma` and `Electron` tokens removed to present as plain Chrome.
- `ALMA_INSTAGRAM_URL` points the app at a local stand-in page for tests.
