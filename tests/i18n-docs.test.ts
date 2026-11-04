// Spec 025 phase G: documentation, skills and comments in English; the doc names follow (AC-7.5).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkDocsBaseline, countSpanishLines, DOCS_BASELINE, isCovered, spanishLines } from './support/docs-language'

const root = resolve(__dirname, '..')

/** The rename map of task G1: old name → new name. */
const RENAMED: Record<string, string> = {
  'docs/security/CONTROLES.md': 'docs/security/CONTROLS.md',
  'docs/security/RIESGOS.md': 'docs/security/RISKS.md',
  'docs/security/PRIVACIDAD.md': 'docs/security/PRIVACY.md',
  'docs/modules/archivos-y-comandos.md': 'docs/modules/files-and-commands.md',
  'docs/modules/casa.md': 'docs/modules/home.md',
  'docs/modules/configuraciones.md': 'docs/modules/settings.md',
  'docs/modules/imagenes.md': 'docs/modules/images.md',
  'docs/modules/office-y-dibujos.md': 'docs/modules/office-and-drawings.md',
  'docs/modules/web-y-correo.md': 'docs/modules/web-and-mail.md',
  'docs/modules/rutinas.md': 'docs/modules/routines.md',
  'docs/modules/seguridad.md': 'docs/modules/security.md',
  'docs/modules/vault-y-conocimiento.md': 'docs/modules/vault-and-knowledge.md',
  'docs/modules/empresas.md': 'docs/modules/companies.md',
  'docs/modules/agentes.md': 'docs/modules/agents.md',
  'docs/modules/aprobaciones.md': 'docs/modules/approvals.md',
  'docs/modules/voz.md': 'docs/modules/voice.md',
  'docs/references/datos.md': 'docs/references/data.md',
  'docs/references/herramientas.md': 'docs/references/tools.md',
  'docs/references/limites.md': 'docs/references/limits.md',
  'docs/references/mensajes-ipc.md': 'docs/references/ipc-messages.md',
  'docs/references/ajustes.md': 'docs/references/settings.md',
  'docs/DOMOTICA-PLAN.md': 'docs/HOME-AUTOMATION-PLAN.md',
  'docs/desarrollo.md': 'docs/development.md'
}

/** The files that link to each other: the README, the docs, the specs and ADRs, the CI and the agents' own files. */
function documentFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'assets') continue
      const path = posix.join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(md|yml)$/i.test(entry.name)) found.push(path)
    }
  }
  for (const dir of ['docs', '.specify', '.github', '.claude']) walk(dir)
  return ['README.md', 'SECURITY.md', 'CLAUDE.md', ...found].filter((file) => existsSync(join(root, file)))
}

/** Relative targets of the Markdown links of a file, leaving out code (it shows examples). */
function relativeLinks(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  return [...prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map((m) => m[1].split('#')[0])
    .filter((target) => target && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target))
}

describe('AC-7.5 renamed docs', () => {
  it('AC-7.5 the docs live under their English names and the Spanish ones are gone', () => {
    for (const [from, to] of Object.entries(RENAMED)) {
      expect(existsSync(join(root, from)), from).toBe(false)
      expect(existsSync(join(root, to)), to).toBe(true)
    }
  })

  it('AC-7.5 every relative Markdown link resolves', () => {
    const broken: string[] = []
    for (const file of documentFiles()) {
      const text = readFileSync(join(root, file), 'utf8')
      for (const target of relativeLinks(text)) {
        if (!existsSync(resolve(root, dirname(file), decodeURI(target)))) broken.push(`${file} → ${target}`)
      }
    }
    expect(broken).toEqual([])
  })

  it('AC-7.5 nothing refers to an old name (the CI, the PR template, the agents, the constitution, the specs)', () => {
    const stale: string[] = []
    for (const file of documentFiles()) {
      // Spec 025 lists the old names on purpose: it is the rename map.
      if (file.startsWith('.specify/specs/025-i18n-es-en/')) continue
      const text = readFileSync(join(root, file), 'utf8')
      for (const old of Object.keys(RENAMED)) {
        const name = old.slice(old.lastIndexOf('/') + 1)
        if (new RegExp(`(?<![\\w.-])${name.replace('.', '\\.')}`).test(text)) stale.push(`${file} mentions ${name}`)
      }
    }
    expect(stale).toEqual([])
  })
})

describe('AC-7.1 docs are English', () => {
  const sources = (): Record<string, string> => {
    const files: Record<string, string> = {}
    for (const file of documentFiles()) if (isCovered(file)) files[file] = readFileSync(join(root, file), 'utf8')
    return files
  }

  it('AC-7.1 the lines of Spanish prose per file are exactly the recorded ones (lower the baseline, never raise it)', () => {
    expect(checkDocsBaseline(countSpanishLines(sources()), DOCS_BASELINE)).toEqual([])
  })

  it('AC-7.1 sees Spanish prose and leaves quoted UI text, code and links alone', () => {
    expect(spanishLines('# Título\n\nLa app guarda los datos en una carpeta.\n')).toEqual([1, 3])
    expect(spanishLines('The app keeps its data in a folder.\n')).toEqual([])
    expect(spanishLines('The button says «Guardar cambios» and `configuración.json` is read; see [guide](docs/guía.md).\n')).toEqual([])
    expect(spanishLines('Settings → «Dónde se guarda» says where.\n')).toEqual([])
  })

  it('AC-7.1 fails above the baseline and below it, and covers only docs, README, CLAUDE.md and SECURITY.md', () => {
    expect(checkDocsBaseline({ 'docs/a.md': 3 }, { 'docs/a.md': 2 })).toEqual([expect.stringContaining('baseline 2: write the new text in English')])
    expect(checkDocsBaseline({ 'docs/a.md': 1 }, { 'docs/a.md': 2 })).toEqual([expect.stringContaining('lower the baseline to 1')])
    expect(checkDocsBaseline({}, { 'docs/gone.md': 2 })).toEqual([expect.stringContaining('lower the baseline to 0')])
    expect(countSpanishLines({ 'docs/a.md': 'La app guarda los datos.', 'tests/b.md': 'La app guarda los datos.', 'README.md': 'All English here.' })).toEqual({ 'docs/a.md': 1 })
  })
})

describe('AC-7.6 skills', () => {
  /** Every text file of the design-system skills, with the Spanish lines of each. */
  function spanishInSkills(): string[] {
    const found: string[] = []
    const walk = (dir: string): void => {
      if (!existsSync(join(root, dir))) return
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const path = posix.join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else for (const line of spanishLines(readFileSync(join(root, path), 'utf8'))) found.push(`${path}:${line}`)
      }
    }
    for (const skill of ['umbra-ui', 'console-ui']) for (const base of ['.claude/skills', '.agents/skills']) walk(`${base}/${skill}`)
    return found
  }

  it('AC-7.6 skills have no Spanish text in the console-ui and umbra-ui skill files', () => {
    expect(spanishInSkills()).toEqual([])
  })

  it('AC-7.6 skills keep both copies of umbra-ui the same', () => {
    const files = (base: string): string[] => readdirSync(join(root, base, 'umbra-ui'), { recursive: true }).map(String).sort()
    expect(files('.agents/skills')).toEqual(files('.claude/skills'))
    for (const file of files('.claude/skills').filter((f) => /\.\w+$/.test(f))) {
      expect(readFileSync(join(root, '.agents/skills/umbra-ui', file), 'utf8'), file).toBe(readFileSync(join(root, '.claude/skills/umbra-ui', file), 'utf8'))
    }
  })
})

describe('AC-7.6 agent files and templates', () => {
  it('AC-7.6 agents, commands, templates and the GitHub files have no Spanish text', () => {
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const path = posix.join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.(md|ya?ml)$/i.test(entry.name)) for (const line of spanishLines(readFileSync(join(root, path), 'utf8'))) found.push(`${path}:${line}`)
      }
    }
    for (const dir of ['.claude/agents', '.claude/commands', '.specify/templates', '.github']) walk(dir)
    expect(found).toEqual([])
  })
})

describe('AC-7.2 the style lines', () => {
  const style = (file: string): string => readFileSync(join(root, file), 'utf8').split('\n').filter((line) => /\bstyle\b/i.test(line) && /semicolon|`;`/.test(line)).join('\n')

  it('AC-7.2 none of the three style lines says user-facing text is Spanish rioplatense; each says text goes through the dictionaries', () => {
    for (const file of ['CLAUDE.md', 'docs/architecture.md', '.claude/agents/implementer.md']) {
      const line = style(file)
      expect(line, file).not.toBe('')
      expect(line, file).not.toMatch(/rioplatense/i)
      expect(line, file).toMatch(/dictionaries/)
    }
  })

  it('AC-7.2 CLAUDE.md says commit messages and docs are English', () => {
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toMatch(/commit messages[^\n]*docs[^\n]*English|docs[^\n]*commit messages[^\n]*English/i)
  })
})
