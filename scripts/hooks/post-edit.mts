// PostToolUse hook: lint the file that was just edited. Exit 2 feeds Biome's errors back to the agent.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
const file: string | undefined = input.tool_input?.file_path
const biome = 'node_modules/@biomejs/biome/bin/biome'

if (file && existsSync(file) && /(^|[\\/])(src|tests|scripts)[\\/].*\.tsx?$/.test(file) && existsSync(biome)) {
  const run = spawnSync('node', [biome, 'lint', '--max-diagnostics=10', file], { encoding: 'utf8' })
  if (run.status !== 0) {
    console.error(`${run.stdout}${run.stderr}`.trim())
    process.exit(2)
  }
}
