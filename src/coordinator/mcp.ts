import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig, McpServerStatus } from '../shared/types'
import type { Language } from '../shared/i18n/language'
import { translate } from '../shared/i18n/messages'
import { ToolError } from './tools/types'
import type { ToolSpec } from './providers/types'

interface McpTool {
  qualifiedName: string
  server: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface ServerEntry {
  configKey: string
  client?: Client
  status: McpServerStatus
  tools: McpTool[]
}

/** Provider tool names allow [a-zA-Z0-9_-] and OpenAI caps them at 64 characters. */
function qualify(server: string, tool: string): string {
  const clean = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Connects to the user's MCP servers and exposes their tools to agents. */
/** The status of a server whose connection closed, in the app language. */
export function closedStatus(name: string, language: Language): McpServerStatus {
  return { name, state: 'error', error: translate(language, 'mcp.closed'), tools: [] }
}

export class McpManager {
  private servers = new Map<string, ServerEntry>()

  constructor(
    private onStatus: (servers: McpServerStatus[]) => void,
    private language: () => Language = () => 'es'
  ) {}

  statuses(): McpServerStatus[] {
    return [...this.servers.values()].map((entry) => entry.status)
  }

  toolSpecs(): ToolSpec[] {
    return this.allTools().map((tool) => ({
      name: tool.qualifiedName,
      description: `[MCP ${tool.server}] ${tool.description}`.slice(0, 1024),
      inputSchema: tool.inputSchema
    }))
  }

  has(qualifiedName: string): boolean {
    return this.allTools().some((tool) => tool.qualifiedName === qualifiedName)
  }

  private allTools(): McpTool[] {
    return [...this.servers.values()].flatMap((entry) => (entry.status.state === 'connected' ? entry.tools : []))
  }

  /** Brings connections in line with the configuration: connect new or changed servers, close removed ones. */
  async sync(configs: Record<string, McpServerConfig>, force = false): Promise<void> {
    const work: Promise<void>[] = []
    for (const [name, entry] of this.servers) {
      if (!configs[name]) {
        this.servers.delete(name)
        work.push(this.close(entry))
      }
    }
    for (const [name, config] of Object.entries(configs)) {
      const configKey = JSON.stringify(config)
      const existing = this.servers.get(name)
      if (existing && existing.configKey === configKey && !force) continue
      if (existing) work.push(this.close(existing))
      work.push(this.connect(name, config, configKey))
    }
    this.emit()
    await Promise.all(work)
  }

  private async connect(name: string, config: McpServerConfig, configKey: string): Promise<void> {
    const entry: ServerEntry = { configKey, tools: [], status: { name, state: 'connecting', tools: [] } }
    if (!config.enabled) entry.status.state = 'disabled'
    this.servers.set(name, entry)
    this.emit()
    if (!config.enabled) return

    const client = new Client({ name: 'alma', version: '0.1.0' })
    try {
      const transport =
        config.type === 'stdio'
          ? new StdioClientTransport({
              command: config.command,
              args: config.args ?? [],
              env: { ...getDefaultEnvironment(), ...config.env },
              cwd: config.cwd || undefined,
              stderr: 'pipe'
            })
          : new StreamableHTTPClientTransport(new URL(config.url), {
              requestInit: { headers: config.headers ?? {} }
            })
      await client.connect(transport, { timeout: 30_000 })
      const allow = config.tools?.length ? new Set(config.tools) : undefined
      const tools = (await client.listTools()).tools.filter((tool) => !allow || allow.has(tool.name))
      if (this.servers.get(name) !== entry) {
        await client.close()
        return
      }
      entry.client = client
      entry.tools = tools.map((tool) => ({
        qualifiedName: qualify(name, tool.name),
        server: name,
        name: tool.name,
        description: tool.description ?? tool.name,
        inputSchema: tool.inputSchema as Record<string, unknown>
      }))
      entry.status = {
        name,
        state: 'connected',
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description }))
      }
      client.onclose = () => {
        if (this.servers.get(name) === entry && entry.status.state === 'connected') {
          entry.status = closedStatus(name, this.language())
          this.emit()
        }
      }
    } catch (error) {
      await client.close().catch(() => {})
      if (this.servers.get(name) === entry) entry.status = { name, state: 'error', error: describeError(error), tools: [] }
    }
    this.emit()
  }

  private async close(entry: ServerEntry): Promise<void> {
    entry.status = { ...entry.status, state: 'disabled', tools: [] }
    await entry.client?.close().catch(() => {})
  }

  async call(qualifiedName: string, input: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
    for (const entry of this.servers.values()) {
      const tool = entry.tools.find((t) => t.qualifiedName === qualifiedName)
      if (!tool || !entry.client) continue
      const result = await entry.client.callTool(
        { name: tool.name, arguments: (input ?? {}) as Record<string, unknown> },
        undefined,
        { signal, timeout: 300_000 }
      )
      const parts: string[] = []
      const content = Array.isArray(result.content) ? result.content : []
      for (const item of content as { type: string; text?: string; resource?: { uri?: string; text?: string } }[]) {
        if (item.type === 'text' && item.text) parts.push(item.text)
        else if (item.type === 'resource' && item.resource) parts.push(item.resource.text ?? `[recurso ${item.resource.uri}]`)
        else parts.push(`[contenido ${item.type} omitido]`)
      }
      if (parts.length === 0 && 'structuredContent' in result && result.structuredContent) {
        parts.push(JSON.stringify(result.structuredContent, null, 2))
      }
      return { text: parts.join('\n') || '(no content)', isError: result.isError === true }
    }
    throw new ToolError('tool.mcp.unavailable', { name: qualifiedName })
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.servers.values()].map((entry) => this.close(entry)))
  }

  private emit(): void {
    this.onStatus(this.statuses())
  }
}
