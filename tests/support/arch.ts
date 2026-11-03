import { readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

export interface Rule {
  name: string
  /** Files the rule applies to (repo-relative, forward slashes). */
  from: RegExp
  /** Resolved import specifiers it forbids: repo-relative path for relative imports, the bare name otherwise. */
  forbid: RegExp
}

/** The layer map from docs/architecture.md, one rule per arrow that must not exist. */
export const RULES: Rule[] = [
  { name: 'shared is a leaf: it cannot know who uses it', from: /^src\/shared\//, forbid: /^src\/(main|coordinator|renderer|preload)\// },
  {
    name: 'renderer talks to the rest only through IPC: no main/coordinator, no node, no electron, no node-only shared modules',
    from: /^src\/renderer\//,
    forbid: /^(src\/(main|coordinator)\/|node:|electron$|src\/shared\/audit(\.|$))/
  },
  { name: 'coordinator never reaches into main or renderer', from: /^src\/coordinator\//, forbid: /^src\/(main|renderer|preload)\// },
  { name: 'only coordinator/index.ts touches electron; logic stays testable without it', from: /^src\/coordinator\/(?!index\.ts$)/, forbid: /^electron$/ },
  { name: 'main never reaches into coordinator or renderer', from: /^src\/main\//, forbid: /^src\/(coordinator|renderer)\// }
]

const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g

export function importsOf(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((m) => m[1])
}

export function resolveSpecifier(file: string, specifier: string): string {
  return specifier.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), specifier)) : specifier
}

/** `files` maps repo-relative path to source text. Returns one message per forbidden import. */
export function violations(files: Record<string, string>, rules: Rule[] = RULES): string[] {
  const found: string[] = []
  for (const [file, source] of Object.entries(files)) {
    for (const specifier of importsOf(source)) {
      const target = resolveSpecifier(file, specifier)
      for (const rule of rules) if (rule.from.test(file) && rule.forbid.test(target)) found.push(`${file} imports ${specifier}: ${rule.name}`)
    }
  }
  return found
}

export function readSources(root: string, dir = 'src'): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue
    const absolute = join(entry.parentPath, entry.name)
    files[posix.join(dir, ...absolute.slice(join(root, dir).length + 1).split(/[\\/]/))] = readFileSync(absolute, 'utf8')
  }
  return files
}
