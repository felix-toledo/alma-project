import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpManager } from '../src/coordinator/mcp'
import type { McpServerStatus } from '../src/shared/types'

const fixture = join(__dirname, 'fixtures', 'echo-mcp-server.mjs')
let manager: McpManager

afterEach(async () => manager?.closeAll())

describe('McpManager', () => {
  it('connects to a stdio server, lists and calls its tools', async () => {
    const updates: McpServerStatus[][] = []
    manager = new McpManager((servers) => updates.push(servers))
    await manager.sync({ 'mi eco': { type: 'stdio', command: process.execPath, args: [fixture], enabled: true } })

    expect(manager.statuses()).toEqual([
      expect.objectContaining({ name: 'mi eco', state: 'connected', tools: [expect.objectContaining({ name: 'echo' }), expect.objectContaining({ name: 'fail' })] })
    ])
    expect(manager.toolSpecs().map((t) => t.name)).toEqual(['mcp__mi_eco__echo', 'mcp__mi_eco__fail'])
    expect(updates.some((s) => s[0]?.state === 'connecting')).toBe(true)

    const signal = new AbortController().signal
    await expect(manager.call('mcp__mi_eco__echo', { text: 'hola' }, signal)).resolves.toEqual({ text: 'eco: hola', isError: false })
    await expect(manager.call('mcp__mi_eco__fail', {}, signal)).resolves.toEqual({ text: 'falló a propósito', isError: true })
  }, 30_000)

  it('reports disabled and broken servers without throwing', async () => {
    manager = new McpManager(() => {})
    await manager.sync({
      apagado: { type: 'stdio', command: process.execPath, args: [fixture], enabled: false },
      roto: { type: 'stdio', command: 'comando-que-no-existe-xyz', enabled: true }
    })
    const byName = Object.fromEntries(manager.statuses().map((s) => [s.name, s]))
    expect(byName.apagado.state).toBe('disabled')
    expect(byName.roto.state).toBe('error')
    expect(manager.toolSpecs()).toEqual([])
  }, 30_000)

  it('exposes only allowlisted tools', async () => {
    manager = new McpManager(() => {})
    await manager.sync({ eco: { type: 'stdio', command: process.execPath, args: [fixture], enabled: true, tools: ['echo'] } })
    expect(manager.toolSpecs().map((t) => t.name)).toEqual(['mcp__eco__echo'])
    expect(manager.statuses()[0].tools.map((t) => t.name)).toEqual(['echo'])
  }, 30_000)

  it('disconnects servers removed from the configuration', async () => {
    manager = new McpManager(() => {})
    await manager.sync({ eco: { type: 'stdio', command: process.execPath, args: [fixture], enabled: true } })
    expect(manager.toolSpecs()).toHaveLength(2)
    await manager.sync({})
    expect(manager.statuses()).toEqual([])
    expect(manager.toolSpecs()).toEqual([])
  }, 30_000)
})
