import type { McpServerConfig } from '../shared/types'

/** What a stdio server would launch, or '' if it wouldn't launch at all (http, or switched off). */
function launches(config: McpServerConfig | undefined): string {
  return config?.type === 'stdio' && config.enabled ? JSON.stringify([config.command, config.args ?? [], config.cwd ?? '', config.env ?? {}]) : ''
}

/**
 * Programs a settings change would make Alma start that it wasn't starting: a new stdio server, a changed command,
 * arguments, folder or environment, or one switched on. Changing these is code execution, so main asks the person
 * itself (a native dialog the page can't click) before applying it.
 */
export function newCommands(before: Record<string, McpServerConfig>, after: Record<string, McpServerConfig>): string[] {
  return Object.entries(after)
    .filter(([name, config]) => launches(config) && launches(config) !== launches(before[name]))
    .map(([name, config]) => (config.type === 'stdio' ? `${name}: ${[config.command, ...(config.args ?? [])].join(' ')}` : name))
}
