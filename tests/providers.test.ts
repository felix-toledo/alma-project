import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { importMcpJson } from '../src/shared/mcp-import'
import type { ChatMessage } from '../src/shared/types'
import { toAnthropicMessages } from '../src/coordinator/providers/anthropic'
import { errorMessageOf, pickDefaultGrokModel, toOpenAiMessages, XaiProvider } from '../src/coordinator/providers/xai'

const history: ChatMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'leé a.txt' }], ts: 0 },
  {
    role: 'assistant',
    provider: 'xai',
    content: [
      { type: 'thinking', thinking: 'razono' },
      { type: 'text', text: 'Lo leo.' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }
    ],
    ts: 0
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'no existe', is_error: true }], ts: 0 }
]

describe('xAI conversion', () => {
  it('maps tool calls and results to the OpenAI chat format', () => {
    expect(toOpenAiMessages('sys', history)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'leé a.txt' },
      {
        role: 'assistant',
        content: 'Lo leo.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ERROR: no existe' }
    ])
  })

  it("replays DeepSeek's own reasoning, which its tool loop requires", () => {
    const own = history.map((m) => (m.role === 'assistant' ? { ...m, provider: 'deepseek' as const } : m))
    expect(toOpenAiMessages('sys', own, 'deepseek')[2]).toMatchObject({ role: 'assistant', reasoning_content: 'razono' })
    // Another provider's thinking never goes to DeepSeek.
    expect(toOpenAiMessages('sys', history, 'deepseek')[2]).not.toHaveProperty('reasoning_content')
  })

  it('picks the newest general Grok model', () => {
    // xAI's list as of October 2026: 4.20 predates 4.3, and the multi-agent model only takes the Responses API.
    const current = [
      'grok-4.20-multi-agent-0309',
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
      'grok-4.3',
      'grok-4.7',
      'grok-4.6',
      'grok-build-0.1',
      'grok-imagine-image-quality',
      'grok-voice-3.0'
    ]
    expect(pickDefaultGrokModel(current)).toBe('grok-4.7')
    expect(pickDefaultGrokModel(['grok-4.20-multi-agent-0309', 'grok-4.20-0309-reasoning', 'grok-4.3'])).toBe('grok-4.3')
    expect(pickDefaultGrokModel(['grok-2-image', 'grok-4-fast-reasoning', 'grok-4-0709', 'grok-3-mini'])).toBe('grok-4-0709')
    expect(pickDefaultGrokModel(['otro'])).toBeUndefined()
  })
})

describe('Anthropic conversion', () => {
  it('drops foreign thinking and keeps tool blocks', () => {
    expect(toAnthropicMessages(history)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'leé a.txt' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Lo leo.' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'no existe', is_error: true }] }
    ])
  })

  it('replays Claude content unchanged, including thinking signatures', () => {
    const raw = [
      { type: 'thinking', thinking: 'resumen', signature: 'sig' },
      { type: 'text', text: 'hola', citations: null }
    ]
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hola' }], ts: 0 },
      { role: 'assistant', provider: 'anthropic', raw, content: [{ type: 'text', text: 'hola' }], ts: 0 }
    ]
    expect(toAnthropicMessages(messages)[1]).toEqual({ role: 'assistant', content: raw })
  })
})

describe('importMcpJson', () => {
  it('reads Claude Desktop / Cursor style configs', () => {
    const imported = importMcpJson(
      JSON.stringify({
        mcpServers: {
          fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\x'], env: { A: '1' } },
          remoto: { url: 'https://ejemplo.com/mcp', headers: { Authorization: 'Bearer t' } },
          roto: 'nada'
        }
      })
    )
    expect(imported).toEqual({
      fs: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\x'], env: { A: '1' }, enabled: true },
      remoto: { type: 'http', url: 'https://ejemplo.com/mcp', headers: { Authorization: 'Bearer t' }, enabled: true }
    })
  })
})

describe('xAI errors', () => {
  let server: Server
  let baseUrl = ''
  beforeAll(async () => {
    // xAI answers errors as { code, ... } without OpenAI's { error: { message } } envelope.
    server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 'Client specified an invalid argument', message: 'Model grok-x only supports the Responses API' }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })
  afterAll(() => server.close())

  it('reports the reason xAI gives instead of "no body"', async () => {
    const provider = new XaiProvider('xai-test', baseUrl)
    const turn = provider.streamTurn({
      model: 'grok-x',
      effort: 'medium',
      system: 'sys',
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hola' }], ts: 0 }],
      signal: new AbortController().signal,
      onText: () => {},
      onThinking: () => {},
      onToolStart: () => {}
    })
    await expect(turn).rejects.toThrow('400 Model grok-x only supports the Responses API (Client specified an invalid argument)')
  })

  it('finds the message in the common error shapes', () => {
    expect(errorMessageOf('{"error":{"message":"bad model"}}')).toBe('bad model')
    expect(errorMessageOf('{"code":"Some entity was not found","error":"The model does not exist"}')).toBe(
      'The model does not exist (Some entity was not found)'
    )
    expect(errorMessageOf('{"detail":"nope"}')).toBe('nope')
    expect(errorMessageOf('{"code":"Bad request"}')).toBe('Bad request')
    expect(errorMessageOf('upstream exploded')).toBe('upstream exploded')
  })
})
