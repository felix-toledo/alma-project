// The hub: Alma's live view of the house. Keeps a WebSocket to Home Assistant, mirrors states and registries, and
// does everything a person or an agent can ask for (control, rename, move, add, remove, scenes, automations).
import type { FlowStep, HomeArea, HomeAutomation, HomeEntry, HomeIntegration, HomeScene, HomeSnapshot, HomeThing } from '../../shared/home'
import type { Language } from '../../shared/i18n/language'
import { abortFlow, listIntegrations, resetFlowCache, startFlow, stepFlow } from './flow'
import { HaClient, HaError, type HaEvent, type StateObject } from './ha'
import { buildAreas, buildAutomations, buildScenes, buildThings, findThings, type RegArea, type RegDevice, type RegEntity } from './model'

export interface StateChange {
  entityId: string
  from: string | null
  to: string | null
  attributes: Record<string, unknown>
}

const DEBOUNCE_MS = 300
/** Integrations that are plumbing, not something the user added. */
const HIDDEN_ENTRIES = new Set(['sun', 'radio_browser', 'google_translate', 'met', 'backup', 'hassio', 'cloud', 'go2rtc', 'shopping_list'])

export class HomeHub {
  /** The app language, read when a list is built: what it sorts by and what Home Assistant is asked for. */
  constructor(private language: () => Language = () => 'es') {}

  private ha: HaClient | null = null
  private states = new Map<string, StateObject>()
  private areas: RegArea[] = []
  private devices: RegDevice[] = []
  private entities: RegEntity[] = []
  private timer?: NodeJS.Timeout
  private retry?: NodeJS.Timeout
  private target: { url: string; token: string } | null = null
  private attempts = 0
  private snapshotListeners = new Set<(snapshot: HomeSnapshot) => void>()
  private changeListeners = new Set<(change: StateChange) => void>()
  private registryTimer?: NodeJS.Timeout
  /** True once states and registries have been read: before that the house looks empty. */
  private loaded = false

  onSnapshot(listener: (snapshot: HomeSnapshot) => void): () => void {
    this.snapshotListeners.add(listener)
    return () => this.snapshotListeners.delete(listener)
  }

  onChange(listener: (change: StateChange) => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  get ready(): boolean {
    return this.loaded && !!this.ha?.connected
  }

  get baseUrl(): string {
    return this.ha?.baseUrl ?? this.target?.url ?? ''
  }

  private client(): HaClient {
    if (!this.ha?.connected) throw new HaError('tool.ha.houseOff')
    return this.ha
  }

  // ---------------------------------------------------------------------------
  // Connection

  /** Connects (and keeps reconnecting) to Home Assistant at `url` with `token`. */
  async connect(url: string, token: string): Promise<void> {
    this.disconnect()
    this.target = { url, token }
    this.attempts = 0
    await this.open()
  }

  private async open(): Promise<void> {
    const target = this.target
    if (!target) return
    const client = new HaClient(target.url, target.token)
    client.onClose = () => {
      this.loaded = false
      this.scheduleReconnect()
    }
    client.onEvent((event) => this.onEvent(event))
    await client.connect()
    this.ha = client
    await Promise.all([this.loadStates(), this.loadRegistries()])
    await Promise.all(['state_changed', 'area_registry_updated', 'device_registry_updated', 'entity_registry_updated'].map((type) => client.subscribe(type)))
    this.attempts = 0
    this.loaded = true
    this.emitSnapshot(true)
  }

  private scheduleReconnect(): void {
    if (!this.target) return
    clearTimeout(this.retry)
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5))
    this.retry = setTimeout(() => void this.open().catch(() => this.scheduleReconnect()), delay)
  }

  disconnect(): void {
    clearTimeout(this.retry)
    clearTimeout(this.timer)
    this.target = null
    this.loaded = false
    this.ha?.close()
    this.ha = null
    this.states.clear()
  }

  private async loadStates(): Promise<void> {
    const list = await this.client().call<StateObject[]>({ type: 'get_states' })
    this.states = new Map(list.map((s) => [s.entity_id, s]))
  }

  private async loadRegistries(): Promise<void> {
    const ha = this.client()
    ;[this.areas, this.devices, this.entities] = await Promise.all([
      ha.call<RegArea[]>({ type: 'config/area_registry/list' }),
      ha.call<RegDevice[]>({ type: 'config/device_registry/list' }),
      ha.call<RegEntity[]>({ type: 'config/entity_registry/list' })
    ])
  }

  private onEvent(event: HaEvent): void {
    if (event.event_type === 'state_changed') {
      const { entity_id: entityId, old_state: old, new_state: next } = event.data
      if (!entityId) return
      if (next) this.states.set(entityId, next)
      else this.states.delete(entityId)
      if (old?.state !== next?.state) {
        const change: StateChange = { entityId, from: old?.state ?? null, to: next?.state ?? null, attributes: next?.attributes ?? {} }
        for (const listener of this.changeListeners) listener(change)
      }
      this.emitSnapshot()
      return
    }
    // A registry changed: reload them, and the states that came with new entities.
    clearTimeout(this.registryTimer)
    this.registryTimer = setTimeout(() => void Promise.all([this.loadStates(), this.loadRegistries()]).then(() => this.emitSnapshot(true)).catch(() => undefined), 500)
  }

  private emitSnapshot(now = false): void {
    clearTimeout(this.timer)
    const fire = (): void => {
      const snapshot = this.snapshot()
      for (const listener of this.snapshotListeners) listener(snapshot)
    }
    if (now) fire()
    else this.timer = setTimeout(fire, DEBOUNCE_MS)
  }

  // ---------------------------------------------------------------------------
  // Reading

  snapshot(): HomeSnapshot {
    return {
      things: buildThings(this.states, this.areas, this.devices, this.entities, this.language()),
      areas: buildAreas(this.areas, this.language()),
      scenes: buildScenes(this.states, this.language()),
      automations: buildAutomations(this.states, this.language())
    }
  }

  thing(id: string): HomeThing | undefined {
    return this.snapshot().things.find((t) => t.id === id || t.entityId === id)
  }

  /** Things matching words like "luz cocina"; the id of a thing or an entity works too. */
  find(query: string): HomeThing[] {
    const snapshot = this.snapshot()
    const exact = snapshot.things.filter((t) => t.id === query || t.entityId === query)
    return exact.length ? exact : findThings(snapshot.things, snapshot.areas, query)
  }

  state(entityId: string): StateObject | undefined {
    return this.states.get(entityId)
  }

  areaIdByName(name: string): string | undefined {
    const wanted = name.trim().toLowerCase()
    return this.areas.find((a) => a.name.toLowerCase() === wanted || a.area_id === wanted)?.area_id
  }

  // ---------------------------------------------------------------------------
  // Acting

  async callService(domain: string, service: string, data: Record<string, unknown> = {}, entityId?: string | string[]): Promise<void> {
    await this.client().call({ type: 'call_service', domain, service, service_data: data, ...(entityId ? { target: { entity_id: entityId } } : {}) })
  }

  /** "light/turn_on" → light.turn_on on that entity. */
  async control(entityId: string, service: string, data: Record<string, unknown> = {}): Promise<void> {
    const [domain, name] = service.includes('/') ? service.split('/') : [entityId.slice(0, entityId.indexOf('.')), service]
    await this.callService(domain, name, data, entityId)
  }

  async updateThing(id: string, patch: { name?: string; areaId?: string | null }): Promise<void> {
    const ha = this.client()
    const thing = this.thing(id)
    if (!thing) throw new HaError('tool.ha.noDevice')
    const isDevice = this.devices.some((d) => d.id === id)
    if (isDevice) {
      await ha.call({ type: 'config/device_registry/update', device_id: id, ...(patch.name !== undefined ? { name_by_user: patch.name.trim() || null } : {}), ...(patch.areaId !== undefined ? { area_id: patch.areaId } : {}) })
    } else {
      await ha.call({ type: 'config/entity_registry/update', entity_id: thing.entityId, ...(patch.name !== undefined ? { name: patch.name.trim() || null } : {}), ...(patch.areaId !== undefined ? { area_id: patch.areaId } : {}) })
    }
  }

  /** Removes a device from Home Assistant; when its integration won't allow it, hides it instead. */
  async removeThing(id: string): Promise<string> {
    const ha = this.client()
    const device = this.devices.find((d) => d.id === id)
    if (!device) {
      const thing = this.thing(id)
      if (!thing) throw new HaError('tool.ha.noDevice')
      await ha.call({ type: 'config/entity_registry/update', entity_id: thing.entityId, disabled_by: 'user' })
      return 'It was hidden.'
    }
    const linked = new Set([...(device.config_entries ?? []), ...this.entities.filter((e) => e.device_id === id && e.config_entry_id).map((e) => e.config_entry_id as string)])
    try {
      for (const entryId of linked) {
        // A camera or a bulb is its own entry: delete it, so adding it again starts clean. Entries with several devices only lose this one.
        const shared = this.devices.some((d) => d.id !== id && (d.config_entries ?? []).includes(entryId))
        if (shared) await ha.call({ type: 'config/device_registry/remove_config_entry', device_id: id, config_entry_id: entryId })
        else await ha.rest('DELETE', `/api/config/config_entries/entry/${entryId}`)
      }
      return 'It was removed.'
    } catch {
      await ha.call({ type: 'config/device_registry/update', device_id: id, disabled_by: 'user' })
      return 'That integration does not allow removing single devices: it was hidden.'
    }
  }

  async createArea(name: string): Promise<HomeArea> {
    const area = await this.client().call<RegArea>({ type: 'config/area_registry/create', name: name.trim() })
    this.areas.push(area)
    return { id: area.area_id, name: area.name }
  }

  async renameArea(areaId: string, name: string): Promise<void> {
    await this.client().call({ type: 'config/area_registry/update', area_id: areaId, name: name.trim() })
  }

  async deleteArea(areaId: string): Promise<void> {
    await this.client().call({ type: 'config/area_registry/delete', area_id: areaId })
  }

  /** The area called `name`, created when it doesn't exist. */
  async ensureArea(name: string): Promise<string> {
    return this.areaIdByName(name) ?? (await this.createArea(name)).id
  }

  // ---------------------------------------------------------------------------
  // Adding devices (config flows) and integrations

  integrations(): Promise<HomeIntegration[]> {
    return listIntegrations(this.client(), this.language())
  }

  async entries(): Promise<HomeEntry[]> {
    const list = await this.client().rest<{ entry_id: string; domain: string; title: string; state: string }[]>('GET', '/api/config/config_entries/entry')
    return list.filter((e) => !HIDDEN_ENTRIES.has(e.domain)).map((e) => ({ entryId: e.entry_id, domain: e.domain, title: e.title, state: e.state }))
  }

  startFlow(domain: string, language: Language = 'es'): Promise<FlowStep> {
    return startFlow(this.client(), domain, language)
  }

  async stepFlow(flowId: string, data?: Record<string, unknown>, menu?: string, language: Language = 'es'): Promise<FlowStep> {
    const step = await stepFlow(this.client(), flowId, data, menu, language)
    if (step.kind === 'done' || step.kind === 'abort') await this.reviveDevices(step.handler).catch(() => undefined)
    return step
  }

  /** A device hidden earlier stays hidden when its integration is added again: bring back the ones that were hidden from here. */
  private async reviveDevices(domain: string): Promise<void> {
    const ha = this.client()
    await this.loadRegistries()
    const hidden = this.devices.filter((d) => d.disabled_by === 'user' && this.entities.some((e) => e.device_id === d.id && e.platform === domain))
    for (const device of hidden) await ha.call({ type: 'config/device_registry/update', device_id: device.id, disabled_by: null })
    if (hidden.length) {
      await Promise.all([this.loadStates(), this.loadRegistries()])
      this.emitSnapshot(true)
    }
  }

  abortFlow(flowId: string): Promise<void> {
    return abortFlow(this.client(), flowId)
  }

  async removeEntry(entryId: string): Promise<void> {
    await this.client().rest('DELETE', `/api/config/config_entries/entry/${entryId}`)
  }

  resetCaches(): void {
    resetFlowCache()
  }

  // ---------------------------------------------------------------------------
  // Scenes ("modos") and automations ("reglas")

  /** Saves a scene: what each entity should be (state plus attributes such as brightness). */
  async saveScene(name: string, entities: Record<string, Record<string, unknown>>, id?: string): Promise<string> {
    const sceneId = id ?? `alma_${Date.now().toString(36)}`
    await this.client().rest('POST', `/api/config/scene/config/${sceneId}`, { name, entities })
    await this.callService('scene', 'reload')
    return sceneId
  }

  async deleteScene(entityId: string): Promise<void> {
    const sceneId = this.states.get(entityId)?.attributes.id
    if (typeof sceneId !== 'string') throw new HaError('tool.ha.noDeleteScene')
    await this.client().rest('DELETE', `/api/config/scene/config/${sceneId}`)
    await this.callService('scene', 'reload')
  }

  /** The scene's definition, to show or to copy. */
  async sceneConfig(entityId: string): Promise<unknown> {
    const sceneId = this.states.get(entityId)?.attributes.id
    return typeof sceneId === 'string' ? this.client().rest('GET', `/api/config/scene/config/${sceneId}`) : null
  }

  /** Creates or replaces an automation written in Home Assistant's own format. HA validates it. */
  async saveAutomation(config: Record<string, unknown>, id?: string): Promise<string> {
    const automationId = id ?? `alma_${Date.now().toString(36)}`
    await this.client().rest('POST', `/api/config/automation/config/${automationId}`, config)
    return automationId
  }

  automationConfig(id: string): Promise<unknown> {
    return this.client().rest('GET', `/api/config/automation/config/${id}`)
  }

  async deleteAutomation(id: string): Promise<void> {
    await this.client().rest('DELETE', `/api/config/automation/config/${id}`)
  }

  async toggleAutomation(entityId: string, enabled: boolean): Promise<void> {
    await this.callService('automation', enabled ? 'turn_on' : 'turn_off', {}, entityId)
  }

  automations(): HomeAutomation[] {
    return buildAutomations(this.states, this.language())
  }

  scenes(): HomeScene[] {
    return buildScenes(this.states, this.language())
  }

  // ---------------------------------------------------------------------------
  // Cameras and history

  /** A still from a camera (JPEG). */
  async cameraSnapshot(entityId: string): Promise<Buffer> {
    if (!entityId.startsWith('camera.')) throw new HaError('tool.ha.notCamera')
    // Many cameras (Tapo included) allow one video connection at a time: if another is closing, a closed one takes up to ~8 s to let go.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client().rest<Buffer>('GET', `/api/camera_proxy/${entityId}`, undefined, { raw: true, timeoutMs: 20_000 })
      } catch (error) {
        if (attempt >= 5) throw new HaError('tool.ha.cameraFailed', { error: (error as Error).message })
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
  }

  /** Changes of the given entities over the last `hours`, oldest first, as "time state" lines. */
  async history(entityIds: string[], hours: number): Promise<Record<string, { at: string; state: string }[]>> {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString()
    const raw = await this.client().rest<{ entity_id?: string; state: string; last_changed?: string; last_updated?: string }[][]>(
      'GET',
      `/api/history/period/${encodeURIComponent(since)}?filter_entity_id=${entityIds.join(',')}&minimal_response&no_attributes&significant_changes_only`,
      undefined,
      { timeoutMs: 45_000 }
    )
    const out: Record<string, { at: string; state: string }[]> = {}
    for (const series of raw) {
      const id = series[0]?.entity_id
      if (!id) continue
      out[id] = series.map((p) => ({ at: p.last_changed ?? p.last_updated ?? '', state: p.state }))
    }
    return out
  }

  /** Where the window (and a browser) can fetch a camera's live MJPEG stream; the picture token rotates. */
  cameraStreamPath(entityId: string): string | null {
    const picture = this.states.get(entityId)?.attributes.entity_picture
    return typeof picture === 'string' ? picture.replace('/camera_proxy/', '/camera_proxy_stream/') : null
  }
}
