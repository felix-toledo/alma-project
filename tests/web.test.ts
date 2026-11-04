import { afterEach, describe, expect, it, vi } from 'vitest'
import { commandEnv } from '../src/coordinator/tools/shell'
import type { ToolContext } from '../src/coordinator/tools/types'
import { fetchUrlTool, htmlToText, isPrivateHost, parseDuckDuckGo } from '../src/coordinator/tools/web'

const addresses = vi.hoisted(() => ({ byName: {} as Record<string, string> }))
vi.mock('node:dns/promises', () => ({ lookup: async (name: string) => [{ address: addresses.byName[name] ?? '93.184.216.34', family: 4 }] }))

const ctx = { signal: new AbortController().signal } as ToolContext

describe('web tools', () => {
  it('reads DuckDuckGo results, skipping ads and unwrapping redirects', () => {
    const html = `
      <div class="result results_links result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
      <div class="result results_links web-result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.espn.com.ar%2Friver&amp;rut=x">River &amp; <b>resultados</b></a>
        <a class="result__snippet" href="#">Sarmiento 1 - 1 River</a></div>
      <div class="result results_links web-result"><a class="result__a" href="https://www.ole.com.ar/river">Olé</a></div>`
    expect(parseDuckDuckGo(html)).toEqual([
      { title: 'River & resultados', url: 'https://www.espn.com.ar/river', snippet: 'Sarmiento 1 - 1 River' },
      { title: 'Olé', url: 'https://www.ole.com.ar/river', snippet: '' }
    ])
  })

  it('turns a page into readable lines', () => {
    const page = htmlToText('<html><head><title>River &aacute;</title><script>x()</script></head><body><nav>menú</nav><p>Mié. 14 de Oct.</p><div>Sarmiento&nbsp;1 - 1 River</div></body></html>')
    expect(page).toEqual({ title: 'River á', text: 'Mié. 14 de Oct.\nSarmiento 1 - 1 River' })
  })

  it('keeps fetches off this machine and the local network', () => {
    for (const host of ['localhost', '127.0.0.1', '192.168.0.10', '10.1.2.3', '172.20.0.1', '[::1]', 'printer.local']) expect(isPrivateHost(host)).toBe(true)
    for (const host of ['www.espn.com.ar', '8.8.8.8', '172.32.0.1']) expect(isPrivateHost(host)).toBe(false)
  })

  describe('fetch_url', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
      addresses.byName = {}
    })

    it('does not send the request when a public name resolves inside the network', async () => {
      addresses.byName['evil.example'] = '192.168.1.5'
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      await expect(fetchUrlTool.run({ url: 'https://evil.example/x' }, ctx)).rejects.toThrow(/red local/)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('checks every redirect before following it', async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8123/api' } }))
      vi.stubGlobal('fetch', fetchMock)
      await expect(fetchUrlTool.run({ url: 'https://example.com/go' }, ctx)).rejects.toThrow(/red local/)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('reads a page after a public redirect', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/final' } }))
        .mockResolvedValueOnce(new Response('<title>Hola</title><p>mundo</p>', { status: 200, headers: { 'content-type': 'text/html' } }))
      vi.stubGlobal('fetch', fetchMock)
      await expect(fetchUrlTool.run({ url: 'https://example.com/a' }, ctx)).resolves.toContain('mundo')
    })
  })

  it('keeps the provider keys out of commands the model runs', () => {
    const env = commandEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'a', meta_api_key: 'm', TELEGRAM_BOT_TOKEN: 't', HOME: '/h' })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', CI: '1', NO_COLOR: '1' })
  })
})
