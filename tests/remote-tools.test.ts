import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appTools, delegateSpec, type RunContext } from '../src/coordinator/agent'
import { knowledgeTools } from '../src/coordinator/knowledge/tools'
import { builtinTools } from '../src/coordinator/tools'
import { companyTools } from '../src/coordinator/tools/company'
import { emailTools } from '../src/coordinator/tools/email'
import { homeTools, lookAtImageTool } from '../src/coordinator/tools/home'
import { routineTools } from '../src/coordinator/tools/routines'
import { sendTelegramTool } from '../src/coordinator/tools/telegram'
import { endVoiceConversationTool } from '../src/coordinator/tools/voice'
import { webTools } from '../src/coordinator/tools/web'
import { whatsAppTools } from '../src/coordinator/tools/whatsapp'
import { jsonSchemaOf, type ToolDefinition } from '../src/coordinator/tools/types'
import { defaultSettings } from '../src/shared/defaults'
import type { Settings } from '../src/shared/types'
import { readSources, violations, type Rule } from './support/arch'

const root = join(__dirname, '..')

/** Every branch of appTools on: knowledge, home (no company), email, WhatsApp and the voice ending. */
function fullCtx(): RunContext {
  const base = defaultSettings()
  const settings: Settings = {
    ...base,
    email: { ...base.email, address: 'a@example.com', imapHost: 'imap.example.com', smtpHost: 'smtp.example.com' },
    providers: { ...base.providers, email: { apiKey: 'k' } },
    home: { ...base.home, enabled: true }
  }
  return {
    getSettings: () => settings,
    thread: { channel: 'voice' },
    depth: 0,
    knowledge: {},
    whatsapp: {},
    home: {}
  } as unknown as RunContext
}

/** A company seat: company tools on, home tools off even with the house present. */
function companyCtx(): RunContext {
  return {
    getSettings: () => defaultSettings(),
    thread: { channel: 'company' },
    depth: 1,
    knowledge: null,
    whatsapp: null,
    company: {},
    home: {}
  } as unknown as RunContext
}

/**
 * The union of the real registries: a tool added to appTools tomorrow is scanned without touching
 * this file. The membership pins below prove both shapes activate every branch.
 */
const allTools: ToolDefinition[] = [...builtinTools, ...appTools(fullCtx()), ...appTools(companyCtx())]

/** Words of spec 026's remote access. Bare "device" is a house word too (home_add_device), so it is not one. */
const REMOTE_WORDS = /remote|tailscale|passkey|step[-_]?up|pairing|paired|unpair/i

const NO_REMOTE_IMPORTS: Rule = {
  name: 'tools never touch remote access',
  from: /^src\/coordinator\/tools\//,
  forbid: /^src\/(shared\/remote|coordinator\/channels\/remote)\//
}

/** Files under src/ that implement a transport with the test id (AC-3.7). */
function testTransportImpls(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([, text]) => /\bid\s*[:=]\s*['"]test['"]|class\s+\w*(Test|Local)\w*Transport/.test(text))
    .map(([file]) => file)
}

/** The settings of spec 028 only `main` writes: the new scopes, the continue sub-switch and the exclusion list. */
const NEW_KEYS = /vaultExcluded|continueHistory|scopes\.(vault|history)/
const RELAY_KEYS = /relay|routing[-_ ]?id|remote\.transport|\btransport\s*[:=]\s*['"](?:tailscale|relay)/i

describe('remote guards (spec 026 T13)', () => {
  it('AC-1.6 no tool reads or changes remote access', () => {
    expect(allTools.length).toBeGreaterThan(30)
    const names = new Set(allTools.map((tool) => tool.name))
    for (const list of [builtinTools, knowledgeTools, routineTools, webTools, homeTools, emailTools, whatsAppTools, companyTools]) {
      expect(list.length).toBeGreaterThan(0)
      expect(names.has(list[0].name), list[0].name).toBe(true)
    }
    for (const solo of [sendTelegramTool, lookAtImageTool, endVoiceConversationTool]) {
      expect(names.has(solo.name), solo.name).toBe(true)
    }
    for (const tool of allTools) {
      expect(tool.name, `name ${tool.name}`).not.toMatch(REMOTE_WORDS)
      expect(tool.description, `description ${tool.name}`).not.toMatch(REMOTE_WORDS)
    }
    // User-configured MCP servers are outside static enumeration; their new commands get a native confirmation (guard.ts).
    expect(delegateSpec([]).name).not.toMatch(REMOTE_WORDS)
    expect(delegateSpec([]).description).not.toMatch(REMOTE_WORDS)
    expect('Pair a phone over Tailscale, approve with the passkey step-up, revoke the unpaired device').toMatch(REMOTE_WORDS)
  })

  it('AC-1.6 no tool module reaches into the remote channel', () => {
    const sources = readSources(root, 'src/coordinator/tools')
    expect(Object.keys(sources).length).toBeGreaterThan(5)
    expect(violations(sources, [NO_REMOTE_IMPORTS])).toEqual([])
    expect(violations({ 'src/coordinator/tools/x.ts': "import { ROUTES } from '../../shared/remote/api'" }, [NO_REMOTE_IMPORTS])).toHaveLength(1)
    expect(violations({ 'src/coordinator/tools/y.ts': "import { RateLimiter } from '../channels/remote/limits'" }, [NO_REMOTE_IMPORTS])).toHaveLength(1)
  })

  it('AC-3.7 no source under src/ implements the test transport', () => {
    expect(testTransportImpls(readSources(root))).toEqual([])
    expect(testTransportImpls({ 'src/a.ts': "export class LocalTestTransport implements RemoteTransport { readonly id = 'test' as const }" })).toEqual([
      'src/a.ts'
    ])
  })

  it('AC-1.5 (028) no tool reads or changes the new scopes, the sub-switch or the exclusion list', () => {
    expect(allTools.length).toBeGreaterThan(30)
    for (const tool of allTools) {
      expect(`${tool.name} ${tool.description} ${JSON.stringify(jsonSchemaOf(tool.schema))}`, tool.name).not.toMatch(NEW_KEYS)
    }
    const sources = { ...readSources(root, 'src/coordinator/tools'), ...readSources(root, 'src/coordinator/knowledge') }
    expect(Object.keys(sources).length).toBeGreaterThan(10)
    expect(
      Object.entries(sources)
        .filter(([, text]) => NEW_KEYS.test(text))
        .map(([file]) => file)
    ).toEqual([])
    expect(NEW_KEYS.test('settings.remote.vaultExcluded.push(folder)')).toBe(true)
    expect(NEW_KEYS.test('remote.scopes.history = true')).toBe(true)
  })

  it('AC-1.6 (027) no tool reads or changes the relay', () => {
    expect(allTools.length).toBeGreaterThan(30)
    for (const tool of allTools) {
      expect(`${tool.name} ${tool.description} ${JSON.stringify(jsonSchemaOf(tool.schema))}`, tool.name).not.toMatch(RELAY_KEYS)
    }
    const sources = { ...readSources(root, 'src/coordinator/tools'), ...readSources(root, 'src/coordinator/knowledge') }
    expect(Object.keys(sources).length).toBeGreaterThan(10)
    expect(
      Object.entries(sources)
        .filter(([, text]) => RELAY_KEYS.test(text))
        .map(([file]) => file)
    ).toEqual([])
    // No tool module imports the relay's pieces either.
    expect(violations({ 'src/coordinator/tools/z.ts': "import { RelayTransport } from '../channels/remote/relay-transport'" }, [NO_REMOTE_IMPORTS])).toHaveLength(1)
    expect(violations(sources, [NO_REMOTE_IMPORTS])).toEqual([])
    expect(RELAY_KEYS.test('settings.remote.transport = "relay"')).toBe(true)
    expect(RELAY_KEYS.test('const routingId = pc.routingId')).toBe(true)
  })
})
