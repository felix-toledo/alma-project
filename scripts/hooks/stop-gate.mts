// Stop hook: before the agent declares itself done, run lint + typecheck + tests if code changed since the last green run.
// Exit 2 sends the failure back so the agent keeps working. A gate that stays red 3 times in a row stops blocking (loop guard).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'

const CACHE = '.claude/.gate-cache.json'
const WATCHED = /^(src|tests|scripts)\/|^(package\.json|tsconfig.*\.json|biome\.json|vitest\.config\.mts)$/
const ENVIRONMENT = /ERR_PNPM|ENOENT|Cannot find module|not recognized|command not found|EACCES|EPERM/
const MAX_RED = 3

const changed = spawnSync('git', ['ls-files', '-m', '-o', '--exclude-standard'], { encoding: 'utf8' })
  .stdout.split('\n')
  .filter((file) => WATCHED.test(file))
if (!changed.length) process.exit(0)

const stamp = (file: string) => {
  try {
    const { mtimeMs, size } = statSync(file)
    return `${file}:${mtimeMs}:${size}`
  } catch {
    return `${file}:deleted`
  }
}
const fingerprint = createHash('sha1').update(changed.map(stamp).join('\n')).digest('hex')
const cache: { fingerprint?: string; red?: number } = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}
if (cache.fingerprint === fingerprint && !cache.red) process.exit(0)

const run = spawnSync('pnpm', ['run', 'check:fast'], { encoding: 'utf8', shell: true })
const output = `${run.stdout}\n${run.stderr}`.trim()
if (run.status === 0) {
  writeFileSync(CACHE, JSON.stringify({ fingerprint }))
  process.exit(0)
}
if (ENVIRONMENT.test(output)) {
  console.error('Gate could not run (environment problem, not your code):\n' + output.split('\n').slice(-8).join('\n'))
  process.exit(0)
}
const red = cache.fingerprint === fingerprint ? (cache.red ?? 0) + 1 : 1
writeFileSync(CACHE, JSON.stringify({ fingerprint, red }))
if (red >= MAX_RED) {
  console.error(`Gate red ${red} times in a row on the same change; no longer blocking. Tell the user what is failing.`)
  process.exit(0)
}
console.error(`pnpm run check:fast is red. Fix it before finishing:\n${output.split('\n').slice(-60).join('\n')}`)
process.exit(2)
