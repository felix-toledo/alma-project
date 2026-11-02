// Pseudo-TDD gate: a change to logic must come with a change to tests (constitution III).
// Usage: node scripts/require-tests.mts [baseRef]   (default origin/main)
import { execFileSync } from 'node:child_process'

const LOGIC = /^src\/(coordinator|shared|main)\/.+\.ts$/
const ENTRYPOINT = /\.d\.ts$|^src\/(coordinator|main)\/index\.ts$/
const EXEMPT = /\[no-tests:\s*\S.{3,}\]/i

/** Returns why the change is rejected, or null when it is fine. */
export function testGap(changed: string[], messages: string): string | null {
  const logic = changed.filter((file) => LOGIC.test(file) && !ENTRYPOINT.test(file))
  if (!logic.length || changed.some((file) => file.startsWith('tests/'))) return null
  if (EXEMPT.test(messages)) return null
  return `Logic changed with no test changed:\n  ${logic.join('\n  ')}\nAdd or update a test in tests/, or justify in a commit message / PR body with [no-tests: reason].`
}

if (import.meta.main) {
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  const base = process.argv[2] ?? 'origin/main'
  const changed = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean)
  const messages = `${git('log', `${base}..HEAD`, '--format=%B')}\n${process.env.PR_BODY ?? ''}`
  const gap = testGap(changed, messages)
  if (gap) {
    console.error(gap)
    process.exit(1)
  }
}
