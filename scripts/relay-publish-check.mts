// Publishing gate for the relay (spec 027 AC-6.7): run by the human before a deploy, never by `pnpm run check`.
import { ABUSE_CONTACT, BUDGET_CEILING, JURISDICTION, type ReleaseConstants, releaseBlockers } from '../src/shared/remote/relay-config.ts'

/** The verdict for a set of constants, apart from the process, so the failing path can be tested. */
export function publishCheck(constants: ReleaseConstants): { ok: boolean; message: string } {
  const blockers = releaseBlockers(constants)
  if (blockers.length) return { ok: false, message: `relay-publish-check: replace before publishing the relay:\n  ${blockers.join('\n  ')}` }
  return { ok: true, message: 'relay-publish-check: the abuse contact, jurisdiction and budget ceiling are set' }
}

if (import.meta.main) {
  const verdict = publishCheck({ ABUSE_CONTACT, JURISDICTION, BUDGET_CEILING })
  if (!verdict.ok) {
    console.error(verdict.message)
    process.exit(1)
  }
  console.log(verdict.message)
}
