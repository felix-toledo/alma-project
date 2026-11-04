// Spec 025 phase F: what Alma sends to outside services, how it sorts, and the names it writes to disk follow `language`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptLanguage, ddgRegion, fetchUrlTool, webSearchTool } from '../src/coordinator/tools/web'
import type { ToolContext } from '../src/coordinator/tools/types'
import type { Language } from '../src/shared/types'

vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }))

const ctxIn = (language: Language): ToolContext => ({ signal: new AbortController().signal, language }) as ToolContext

afterEach(() => vi.unstubAllGlobals())

describe('AC-3.7 web', () => {
  it('AC-3.7 web picks the DuckDuckGo region and the Accept-Language from the language', () => {
    expect(ddgRegion('es')).toBe('ar-es')
    expect(ddgRegion('en')).toBe('us-en')
    expect(acceptLanguage('es')).toBe('es-AR,es;q=0.9,en;q=0.6')
    expect(acceptLanguage('en')).toBe('en-US,en;q=0.9,es;q=0.6')
  })

  it('AC-3.7 web sends them in the requests', async () => {
    for (const language of ['es', 'en'] as const) {
      const fetchMock = vi.fn(async () => new Response('<title>x</title><p>y</p>', { status: 200, headers: { 'content-type': 'text/html' } }))
      vi.stubGlobal('fetch', fetchMock)
      await webSearchTool.run({ query: 'river' }, ctxIn(language)).catch(() => {})
      const body = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as URLSearchParams
      expect(body.get('kl')).toBe(ddgRegion(language))
      await fetchUrlTool.run({ url: 'https://example.com/a' }, ctxIn(language))
      const headers = (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers as Record<string, string>
      expect(headers['Accept-Language']).toBe(acceptLanguage(language))
    }
  })
})

describe('AC-3.7 home', () => {
  it('AC-3.7 home writes the language into the managed engine configuration', async () => {
    const { managedConfig } = await import('../src/coordinator/home/engine')
    expect(managedConfig(18123, 'UTC')).toContain('  language: es')
    expect(managedConfig(18123, 'UTC', 'en')).toContain('  language: en')
    expect(managedConfig(18123, 'UTC', 'en')).not.toContain('  language: es')
  })

  it('AC-3.7 home creates the Home Assistant user in the language', async () => {
    const { onboard } = await import('../src/coordinator/home/ha')
    for (const language of ['es', 'en'] as const) {
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ auth_code: 'c' }))).mockResolvedValueOnce(new Response('no', { status: 500 }))
      vi.stubGlobal('fetch', fetchMock)
      await expect(onboard('http://ha.test', 'pw', language)).rejects.toThrow()
      expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).language).toBe(language)
    }
  })

  it('AC-3.7 home asks for the config-flow translations and sorts integration names in the language', async () => {
    const { listIntegrations, resetFlowCache, startFlow } = await import('../src/coordinator/home/flow')
    const calls: Record<string, unknown>[] = []
    const ha = {
      rest: async (_method: string, path: string) => (path.includes('flow_handlers') ? ['nube', 'nandu', 'oso'] : { type: 'abort', flow_id: 'f', handler: 'nube', reason: 'x' }),
      call: async (message: Record<string, unknown>) => {
        calls.push(message)
        if (message.type === 'frontend/get_translations' && message.category === 'title') return { resources: { 'component.nube.title': 'Nube', 'component.nandu.title': 'Ñandú', 'component.oso.title': 'Oso' } }
        return { resources: {} }
      }
    } as never
    const names = async (language: 'es' | 'en') => {
      resetFlowCache()
      return (await listIntegrations(ha, language)).map((i) => i.name)
    }
    expect(await names('es')).toEqual(['Nube', 'Ñandú', 'Oso'])
    expect(await names('en')).toEqual(['Ñandú', 'Nube', 'Oso'])
    expect(calls.filter((c) => c.category === 'title').map((c) => c.language)).toEqual(['es', 'en'])
    resetFlowCache()
    calls.length = 0
    await startFlow(ha, 'nube', 'en')
    expect(calls.find((c) => c.category === 'config')?.language).toBe('en')
  })

  it('AC-3.7 home sorts things, areas and scenes with the language collation', async () => {
    const { buildAreas, buildScenes } = await import('../src/coordinator/home/model')
    const areas = [{ area_id: 'a', name: 'Nube' }, { area_id: 'b', name: 'Ñandú' }, { area_id: 'c', name: 'Oso' }]
    expect(buildAreas(areas, 'es').map((a) => a.name)).toEqual(['Nube', 'Ñandú', 'Oso'])
    expect(buildAreas(areas, 'en').map((a) => a.name)).toEqual(['Ñandú', 'Nube', 'Oso'])
    const states = new Map(['scene.a', 'scene.b'].map((id, i) => [id, { entity_id: id, state: 'x', attributes: { friendly_name: i ? 'Ñandú' : 'Nube' } }]))
    expect(buildScenes(states as never, 'en').map((s) => s.name)).toEqual(['Ñandú', 'Nube'])
    expect(buildScenes(states as never, 'es').map((s) => s.name)).toEqual(['Nube', 'Ñandú'])
  })
})

describe('AC-3.8', () => {
  it('AC-3.8 puts the labels of the app language first and keeps English, Spanish and Portuguese', async () => {
    const { instagramLabels } = await import('../src/main/instagram-labels')
    expect(instagramLabels('next', 'es')).toEqual(['Siguiente', 'Next', 'Avançar'])
    expect(instagramLabels('next', 'en')).toEqual(['Next', 'Siguiente', 'Avançar'])
    for (const kind of ['create', 'post', 'next', 'share', 'dismiss', 'success'] as const) {
      for (const language of ['es', 'en'] as const) {
        const labels = instagramLabels(kind, language)
        expect(new Set(labels).size).toBe(labels.length)
        expect(labels.slice().sort()).toEqual(instagramLabels(kind, language === 'es' ? 'en' : 'es').slice().sort())
      }
    }
    expect(instagramLabels('share', 'es')).toEqual(expect.arrayContaining(['Share', 'Compartir', 'Compartilhar']))
    expect(instagramLabels('create', 'en').slice(0, 2)).toEqual(['New post', 'Create'])
    expect(instagramLabels('create', 'es').slice(0, 2)).toEqual(['Nueva publicación', 'Crear'])
  })
})

describe('AC-3.6 sort sites', () => {
  it('AC-3.6 sort sites sorts a file listing with the language collation', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { listDirTool } = await import('../src/coordinator/tools/fs')
    const workspace = mkdtempSync(join(tmpdir(), 'alma-sort-'))
    try {
      for (const name of ['nube.txt', 'ñandu.txt', 'oso.txt']) writeFileSync(join(workspace, name), '')
      const list = async (language: Language) => String(await listDirTool.run({}, { workspace, signal: new AbortController().signal, language } as ToolContext)).split('\n')
      expect(await list('es')).toEqual(['nube.txt', 'ñandu.txt', 'oso.txt'])
      expect(await list('en')).toEqual(['ñandu.txt', 'nube.txt', 'oso.txt'])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('AC-3.6 sort sites leaves no localeCompare but the two version sorts', async () => {
    const { readSources } = await import('./support/arch')
    const sources = readSources(process.cwd())
    const found = Object.keys(sources).filter((file) => sources[file].includes('localeCompare'))
    expect(found.sort()).toEqual(['src/coordinator/images.ts', 'src/coordinator/providers/xai.ts'])
  })
})
