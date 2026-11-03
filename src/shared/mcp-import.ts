import type { McpServerConfig } from './types'

/** Accepts the common `mcp.json` shape: { "mcpServers": { name: {command,args,env} | {url,headers} } }. */
export function importMcpJson(text: string): Record<string, McpServerConfig> {
  const parsed = JSON.parse(text) as Record<string, unknown>
  const servers = (parsed.mcpServers ?? parsed) as Record<string, unknown>
  const out: Record<string, McpServerConfig> = {}
  for (const [name, value] of Object.entries(servers)) {
    if (typeof value !== 'object' || value === null) continue
    const raw = value as Record<string, unknown>
    const tools = Array.isArray(raw.tools) ? { tools: raw.tools.map(String) } : {}
    if (typeof raw.url === 'string') {
      out[name] = { type: 'http', url: raw.url, headers: (raw.headers as Record<string, string>) ?? {}, enabled: true, ...tools }
    } else if (typeof raw.command === 'string') {
      out[name] = {
        type: 'stdio',
        command: raw.command,
        args: Array.isArray(raw.args) ? raw.args.map(String) : [],
        env: (raw.env as Record<string, string>) ?? {},
        ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
        enabled: true,
        ...tools
      }
    }
  }
  return out
}
