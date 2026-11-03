import { describe, expect, it } from 'vitest'
import { newCommands } from '../src/main/guard'
import type { McpServerConfig } from '../src/shared/types'

const stdio = (command: string, over: Partial<Extract<McpServerConfig, { type: 'stdio' }>> = {}): McpServerConfig => ({ type: 'stdio', command, enabled: true, ...over })

describe('settings guard', () => {
  it('flags new, changed and re-enabled commands only', () => {
    const before = { git: stdio('npx', { args: ['server-git'] }), off: stdio('node', { enabled: false }), web: { type: 'http', url: 'https://x', enabled: true } as McpServerConfig }
    expect(newCommands(before, before)).toEqual([])
    expect(newCommands(before, { ...before, git: { ...before.git, tools: ['status'] } })).toEqual([])
    expect(newCommands(before, { ...before, git: stdio('powershell', { args: ['-c', 'x'] }) })).toEqual(['git: powershell -c x'])
    expect(newCommands(before, { ...before, extra: stdio('python') })).toEqual(['extra: python'])
    expect(newCommands(before, { ...before, off: stdio('node') })).toEqual(['off: node'])
    expect(newCommands(before, { ...before, extra: stdio('python', { enabled: false }) })).toEqual([])
  })
})
