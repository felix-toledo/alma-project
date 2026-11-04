// Runs against a real Home Assistant (the one Alma's engine starts). Skipped unless ALMA_HA_URL is set:
//   ALMA_HA_URL=http://127.0.0.1:8123 ALMA_HA_TOKEN=<long-lived token> npx vitest run tests/home-live.test.ts
// With ALMA_HA_ONBOARD=1 and a fresh Home Assistant, the first test creates the account and prints the token.
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HaClient, onboard } from '../src/coordinator/home/ha'

const url = process.env.ALMA_HA_URL
const live = url ? describe : describe.skip

live('Home Assistant en vivo', () => {
  it.runIf(process.env.ALMA_HA_ONBOARD)('crea la cuenta de Alma en una instalación nueva', async () => {
    const result = await onboard(url!, 'prueba-' + Math.random().toString(36).slice(2))
    writeFileSync(process.env.ALMA_HA_TOKEN_FILE ?? 'ha-token.txt', result.token)
    expect(result.token.length).toBeGreaterThan(50)
  }, 60_000)

  it('habla por WebSocket y lista las áreas', async () => {
    const client = new HaClient(url!, process.env.ALMA_HA_TOKEN ?? '')
    await client.connect()
    const areas = await client.call<unknown[]>({ type: 'config/area_registry/list' })
    expect(Array.isArray(areas)).toBe(true)
    const states = await client.call<unknown[]>({ type: 'get_states' })
    expect(states.length).toBeGreaterThan(0)
    client.close()
  })
})

live('Hub sobre Home Assistant en vivo', () => {
  it('arma cosas, controla una luz y lee escenas', async () => {
    const { HomeHub } = await import('../src/coordinator/home/hub')
    const hub = new HomeHub()
    await hub.connect(url!, process.env.ALMA_HA_TOKEN ?? '')
    const snapshot = hub.snapshot()
    console.log(snapshot.things.map((t) => `${t.kind}:${t.name}:${t.state}:${t.areaId}`).join('\n'))
    const light = snapshot.things.find((t) => t.kind === 'light')
    expect(light).toBeTruthy()
    await hub.control(light!.entityId, 'light/turn_on', { brightness_pct: 40 })
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(hub.thing(light!.id)?.on).toBe(true)
    await hub.control(light!.entityId, 'light/turn_off')
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(hub.thing(light!.id)?.on).toBe(false)
    const integrations = await hub.integrations()
    expect(integrations.find((i) => i.domain === 'tuya')?.name).toBe('Tuya')
    const step = await hub.startFlow('tuya')
    expect(step.kind).toBe('form')
    expect(step.fields[0]?.name).toBe('user_code')
    expect(step.fields[0]?.label).toBe('Código de usuario')
    await hub.abortFlow(step.flowId)
    hub.disconnect()
  }, 60_000)
})

// The whole install, for real: downloads Home Assistant (~1.2 GB), imports it as a WSL distro and starts it.
// ALMA_HOME_INSTALL=1 ALMA_HOME_DISTRO=alma-home-test npx vitest run tests/home-live.test.ts -t "motor"
const install = process.env.ALMA_HOME_INSTALL ? describe : describe.skip
install('Motor administrado (instalación real)', () => {
  it('instala, arranca, crea la cuenta, se apaga y vuelve a arrancar', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { HomeEngine, distroExists } = await import('../src/coordinator/home/engine')
    const { HomeHub } = await import('../src/coordinator/home/hub')
    const dataDir = mkdtempSync(join(tmpdir(), 'alma-engine-'))
    const seen: string[] = []
    const settings = { home: { enabled: true, mode: 'managed' as const, externalUrl: '', mirrored: false, agentId: 'general', visionProvider: '', visionModel: '' } }
    const engine = new HomeEngine({
      dataDir,
      settings: () => settings,
      seal: async (text) => `sealed:${Buffer.from(text).toString('base64')}`,
      open: async (text) => Buffer.from(text.replace('sealed:', ''), 'base64').toString(),
      onStatus: (status) => {
        const line = `${status.state}${status.step ? ` · ${status.step}` : ''}`
        if (seen.at(-1) !== line) {
          seen.push(line)
          console.log(new Date().toLocaleTimeString(), line)
        }
      }
    })
    await engine.install()
    expect(engine.status().state).toBe('ready')
    const creds = (await engine.credentials())!
    expect(creds.token.length).toBeGreaterThan(50)
    const hub = new HomeHub()
    await hub.connect(creds.url, creds.token)
    // A fresh Home Assistant starts with a few areas of its own.
    expect(hub.snapshot().areas.map((a) => a.name)).toContain('Cocina')
    const integrations = await hub.integrations()
    expect(integrations.some((i) => i.domain === 'sonoff')).toBe(true) // the custom component was installed
    hub.disconnect()
    await engine.stop()
    expect(engine.status().state).not.toBe('ready')

    // Second start: the account is already there.
    await engine.start()
    expect(engine.status().state).toBe('ready')
    expect((await engine.credentials())!.token).toBe(creds.token)
    await engine.stop()
    await engine.uninstall()
    expect(await distroExists()).toBe(false)
  }, 45 * 60_000)
})
