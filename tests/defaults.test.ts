import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOLS, DEFAULT_AGENTS, defaultSettings } from '../src/shared/defaults'

describe('default agents', () => {
  it('ships a Multimedia agent that can run Remotion and only uses known tools', () => {
    const agent = DEFAULT_AGENTS.find((a) => a.id === 'multimedia')
    expect(agent).toBeDefined()
    expect(agent!.tools).toContain('run_command')
    expect(agent!.tools).toContain('write_file')
    expect(agent!.systemPrompt).toContain('remotion render')
    // Running commands always waits for the user.
    expect(agent!.autoApproveTools ?? []).not.toContain('run_command')
    for (const agent of DEFAULT_AGENTS) for (const tool of agent.tools) expect(BUILTIN_TOOLS).toContain(tool)
  })

  it('ships a Vercel AI Gateway agent with its own key slot', () => {
    expect(DEFAULT_AGENTS.find((a) => a.id === 'vercel')?.provider).toBe('vercel')
    expect(defaultSettings().providers.vercel).toEqual({ apiKey: '' })
  })

  it('has unique agent ids and a default agent that exists', () => {
    const settings = defaultSettings()
    const ids = settings.agents.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(settings.defaultAgentId)
  })
})
