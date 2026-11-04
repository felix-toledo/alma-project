import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import * as z from 'zod/v4'
import { ENTITIES } from './htmlEntities'
import type { Language } from '../../shared/i18n/language'
import { defineTool, languageOf, ToolError, toolText, truncateMiddle } from './types'

// No API key needed: DuckDuckGo's HTML endpoint, and plain page fetches with a browser user agent.
// ponytail: scraped HTML, no key; switch to Brave/Tavily (key in Settings) if DuckDuckGo starts blocking.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
const TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 5

/** DuckDuckGo's region (`kl`) and the page language `fetch_url` asks for follow the app language (spec 025 BR-24). */
export const ddgRegion = (language: Language): string => (language === 'en' ? 'us-en' : 'ar-es')
export const acceptLanguage = (language: Language): string => (language === 'en' ? 'en-US,en;q=0.9,es;q=0.6' : 'es-AR,es;q=0.9,en;q=0.6')


function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, code: string) => {
    if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10))
    return ENTITIES[code] ?? whole
  })
}

const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

/** Readable text of a page: drops scripts, styles and navigation, keeps one line per block. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|head|nav|footer|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d|\/section|\/article|\/table)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim()
  return { title, text }
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** Results from DuckDuckGo's HTML page (ads skipped; redirect links unwrapped). */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = []
  for (const block of html.split(/<div[^>]+class="[^"]*\bresult\b/).slice(1)) {
    if (/result--ad/.test(block.slice(0, 200))) continue
    const link = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!link) continue
    let url = decodeEntities(link[1])
    const redirect = /[?&]uddg=([^&]+)/.exec(url)
    if (redirect) url = decodeURIComponent(redirect[1])
    if (url.startsWith('//')) url = `https:${url}`
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? ''
    results.push({ title: stripTags(link[2]), url, snippet: stripTags(snippet) })
  }
  return results
}

/** The agent reads files too: keep page fetches off this machine and the local network. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  const version = isIP(host)
  if (version === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (version === 6) return host === '::1' || host === '::' || /^(fc|fd|fe80)/.test(host) || host.startsWith('::ffff:')
  return false
}

async function get(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...init,
      headers: { 'User-Agent': UA, ...init.headers },
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
    })
  } catch (error) {
    throw new ToolError('tool.web.connect', { error: (error as Error).message })
  }
}

/** Refuses a name that is private as written or that DNS resolves to a private address (a public name pointing inside). */
async function assertPublic(url: URL): Promise<void> {
  if (isPrivateHost(url.hostname)) throw new ToolError('tool.web.private')
  if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) return
  const addresses = await lookup(url.hostname, { all: true }).catch(() => [])
  if (addresses.some((a) => isPrivateHost(a.address))) throw new ToolError('tool.web.privateDns')
}

/**
 * Fetches a public page following redirects by hand, so every hop is checked before a request leaves, not after.
 * ponytail: the name is resolved here and again by fetch, so DNS rebinding between the two can still slip through;
 * pin the resolved address with a custom undici dispatcher if that ever matters.
 */
async function getPublic(first: URL, signal: AbortSignal, init: RequestInit): Promise<Response> {
  let url = first
  for (let hop = 0; ; hop++) {
    await assertPublic(url)
    const response = await get(url.href, signal, { ...init, redirect: 'manual' })
    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || !location) return response
    if (hop >= MAX_REDIRECTS) throw new ToolError('tool.web.redirectLoop')
    url = new URL(location, url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolError('tool.web.redirectScheme')
  }
}

export const webSearchTool = defineTool({
  name: 'web_search',
  description:
    'Searches the internet and returns the first results (title, link and summary). Use it for anything current or outside the user\'s computer: news, sports results, weather, prices, schedules, facts about companies or public figures, documentation. Summaries often lack the exact fact: open the most promising links with fetch_url.',
  risk: 'read',
  standalone: true,
  schema: z.object({
    query: z.string().min(1).describe('What to search for, as you would type it in a search engine'),
    max_results: z.number().int().min(1).max(10).optional().describe('How many results (default 6)')
  }),
  async run({ query, max_results = 6 }, ctx) {
    const response = await get('https://html.duckduckgo.com/html/', ctx.signal, {
      method: 'POST',
      // No Accept-Language here: DuckDuckGo answers that with its anti-bot page.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: query, kl: ddgRegion(languageOf(ctx)) })
    })
    if (!response.ok) throw new ToolError('tool.web.searchStatus', { status: response.status })
    const html = await response.text()
    const results = parseDuckDuckGo(html).slice(0, max_results)
    if (!results.length) {
      if (/anomaly|captcha/i.test(html)) throw new ToolError('tool.web.captcha')
      return toolText(ctx, 'tool.web.noResults', { query })
    }
    const list = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n')
    return toolText(ctx, 'tool.web.results', { query, data: list })
  }
})

export const fetchUrlTool = defineTool({
  name: 'fetch_url',
  description:
    'Opens a web page and returns its text (no HTML). Use it to read a web_search result or a URL the user gave you. Pages built only with JavaScript may come back almost empty: if that happens, try another result.',
  risk: 'read',
  standalone: true,
  schema: z.object({
    url: z.string().describe('Full address, with https://'),
    max_chars: z.number().int().min(1000).max(60_000).optional().describe('Maximum text to return (default 15000)')
  }),
  async run({ url, max_chars = 15_000 }, ctx) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new ToolError('tool.web.badUrl', { url })
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ToolError('tool.web.badScheme')
    const response = await getPublic(parsed, ctx.signal, { headers: { 'Accept-Language': acceptLanguage(languageOf(ctx)) } })
    if (!response.ok) throw new ToolError('tool.web.pageStatus', { status: response.status, statusText: response.statusText })
    const type = response.headers.get('content-type') ?? ''
    if (!/text|json|xml|html/i.test(type)) throw new ToolError(type ? 'tool.web.notText' : 'tool.web.notTextUnknown', { type })
    const body = await response.text()
    const { title, text } = /html/i.test(type) ? htmlToText(body) : { title: '', text: body }
    const data = truncateMiddle(text || '(the page has no readable text; it may be built with JavaScript)', max_chars)
    return title ? toolText(ctx, 'tool.web.pageTitled', { url: parsed.href, title, data }) : toolText(ctx, 'tool.web.page', { url: parsed.href, data })
  }
})

export const webTools = [webSearchTool, fetchUrlTool]
