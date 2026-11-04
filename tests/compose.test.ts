import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compose, fitFontSize, loadLibrary, sanitizeSvg, TEMPLATES } from '../src/coordinator/compose'
import { FONTS } from '../src/coordinator/compose/library'
import { composeImageTool } from '../src/coordinator/tools/media'
import { defaultSettings } from '../src/shared/defaults'
import type { HostRequest } from '../src/shared/types'

let workspace: string
beforeEach(() => (workspace = mkdtempSync(join(tmpdir(), 'alma-compose-'))))
afterEach(() => rmSync(workspace, { recursive: true, force: true }))

describe('compose', () => {
  it('draws every template in every format, deterministically per seed', () => {
    for (const template of Object.keys(TEMPLATES)) {
      for (const aspect_ratio of ['1:1', '4:5', '16:9', '9:16'] as const) {
        const input = { template, aspect_ratio, title: 'Hoy empieza todo', subtitle: 'Sub', text: '- uno\n- dos', badge: '01', footer: '@alma', seed: 7 }
        const a = compose(input)
        expect(a.svg).toMatch(/^<svg [^>]*viewBox="0 0 \d+ \d+"/)
        expect(a.svg).toBe(compose(input).svg)
      }
    }
  })

  it('escapes text and embeds only the fonts it uses', () => {
    const { svg } = compose({ template: 'titular', title: '<b>Hola & chau</b>', seed: 1 })
    expect(svg).toContain('&lt;b&gt;Hola &amp; chau&lt;/b&gt;')
    expect(svg).toContain("font-family:'Bebas Neue'")
    expect(svg).not.toContain("font-family:'Pacifico'")
  })

  it('rejects unknown names with the valid options', () => {
    expect(() => compose({ palette: 'nope' })).toThrow(/Paleta desconocida.*papel/)
    expect(() => compose({ elements: [{ type: 'dragon' }] })).toThrow(/Elemento desconocido.*blob/)
    expect(() => compose({ font: 'comic' })).toThrow(/Fuente desconocida.*moderna/)
  })

  it('keeps text readable when brand colors would hide it', () => {
    const { svg } = compose({ template: 'minimal', title: 'x', colors: { background: '#ffffff', text: '#fefefe' }, seed: 1 })
    expect(svg).toContain('color:#111111')
  })

  it('strips scripts, handlers and remote links from overlays', () => {
    const clean = sanitizeSvg('<circle onclick="x()" r="4"/><script>alert(1)</script><image href="https://evil/x.png"/><use href="#a"/>')
    expect(clean).not.toMatch(/onclick|script|evil/)
    expect(clean).toContain('href="#a"')
  })

  it('fits long titles smaller than short ones', () => {
    const font = FONTS.moderna
    const short = fitFontSize('Hola', 800, 400, font, 200)
    const long = fitFontSize('Un título bastante más largo que no entra en una sola línea', 800, 400, font, 200)
    expect(long).toBeLessThan(short)
    expect(long * font.charWidth * 'bastante'.length).toBeLessThan(800)
  })
})

describe('user library', () => {
  it('uses palettes, pieces, fonts and the logo from biblioteca/', async () => {
    const dir = join(workspace, 'biblioteca')
    mkdirSync(dir)
    writeFileSync(join(dir, 'paletas.json'), JSON.stringify({ marca: { background: '#102030', accents: ['#ff8800'] } }))
    writeFileSync(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(dir, 'Flor.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(dir, 'MiFuente.ttf'), 'fake')
    const library = await loadLibrary(dir)
    const { svg, summary } = compose({ title: 'Hola', font: 'mifuente', elements: [{ type: 'estrella' }, { type: 'Flor' }], seed: 3 }, library)
    expect(summary).toContain('paleta: marca')
    expect(svg).toContain('#102030')
    expect(svg).toContain("font-family:'u-mifuente'")
    expect(svg).toContain('data:image/svg+xml') // the logo, as an image
    expect(svg).toMatch(/<svg xmlns="http:\/\/www.w3.org\/2000\/svg" x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" color="#[0-9a-f]{6}" style="--acento:#[0-9a-f]{6}"\/>/) // the piece, inline

    writeFileSync(join(dir, 'paletas.json'), '{"mala": {"background": "rojo"}}')
    await expect(loadLibrary(dir)).rejects.toThrow(/paletas.json/)
  })

  it('applies recipes, recolors SVG pieces inline and can drop template decorations', async () => {
    const dir = join(workspace, 'biblioteca')
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'chat.svg'),
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" onload="x()"><path fill="currentColor" style="fill:var(--acento)"/></svg>'
    )
    writeFileSync(
      join(dir, 'recetas.json'),
      JSON.stringify({ anuncio: { template: 'anuncio', palette: 'neon', decorations: false, elements: [{ type: 'chat', color: '#123456', color2: '#abcdef' }] } })
    )
    const library = await loadLibrary(dir)
    const { svg, summary } = compose({ recipe: 'Anuncio', title: 'Hola', elements: [{ type: 'circulo' }], seed: 1 }, library)
    expect(summary).toMatch(/Receta: Anuncio · Plantilla: anuncio · paleta: neon/)
    expect(svg).toMatch(/<svg [^>]*viewBox="0 0 24 24"[^>]* color="#123456" style="--acento:#abcdef">/)
    expect(svg).not.toContain('onload')
    expect(svg).toContain('<circle r=') // the caller's elements add to the recipe's
    expect(svg).not.toContain('Q0 0') // no destellos from the anuncio template
    expect(() => compose({ recipe: 'nada' }, library)).toThrow(/Receta desconocida.*anuncio/)

    writeFileSync(join(dir, 'recetas.json'), '{"mala": {"template": "inventada"}}')
    await expect(loadLibrary(dir)).rejects.toThrow(/receta "mala".*template/)
  })
})

describe('compose_image tool', () => {
  it('writes the SVG and asks the main process for the PNG', async () => {
    const requests: HostRequest[] = []
    const ctx = {
      workspace,
      signal: new AbortController().signal,
      settings: defaultSettings(),
      host: { request: async (request: HostRequest) => (requests.push(request), { ok: true, message: '' }) }
    }
    const result = await composeImageTool.run({ template: 'cita', title: 'Ser y estar', seed: 5 }, ctx)
    expect(result).toMatch(/^Imagen guardada: imagenes\/ser-y-estar-\d+-\d+\.png$/m)
    const files = readdirSync(join(workspace, 'imagenes'))
    expect(files.some((f) => f.endsWith('.svg'))).toBe(true)
    const request = requests[0] as Extract<HostRequest, { action: 'image.render' }>
    expect(request).toMatchObject({ action: 'image.render', width: 1080, height: 1350 })
    expect(request.outPath.startsWith(workspace)).toBe(true)
    expect(readFileSync(join(workspace, 'imagenes', files.find((f) => f.endsWith('.svg'))!), 'utf8')).toBe(request.svg)
  })
})
