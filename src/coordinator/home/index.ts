// Home automation, as the coordinator sees it: the engine (Home Assistant), the hub (live view and actions), the plan and the
// rules, wired together and answering the window's `home.*` requests. Agents reach the same pieces through tools/home.ts.
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { planFromDrawing, roomAt, type FlowStep, type HomePlan, type HomeSnapshot, type JudgmentRule } from '../../shared/home'
import { parseDrawing } from '../../shared/excalidraw'
import type { CoordinatorRequest, HomeRulesView, LiveEvent, Settings } from '../../shared/types'
import type { Host } from '../tools/types'
import type { Picture } from '../vision'
import { HomeEngine } from './engine'
import { HomeHub, type StateChange } from './hub'
import { autoPlace, PlanError, PlanStore, replaceFloorShape, sanitizePlan } from './plan'
import { ToolError } from '../tools/types'
import { HomeTriggers } from './triggers'

export interface HomeDeps {
  dataDir: string
  settings(): Settings
  host: Host
  emit(event: LiveEvent): void
  /** A rule that needs judgment fired: run an agent for it. */
  launchRule(rule: JudgmentRule, change: StateChange, thingName: string): void
  /** Tell the user (desktop notification and Telegram), with a picture when there is one. */
  notify(title: string, body: string, photo?: Buffer): void
  /** Reads a file of the active vault. */
  readVault(path: string): Promise<string>
  look(pictures: Picture[], question: string): Promise<{ text: string }>
}

const EMPTY_SNAPSHOT: HomeSnapshot = { things: [], areas: [], scenes: [], automations: [] }

export class HomeService {
  readonly engine: HomeEngine
  readonly hub = new HomeHub(() => this.deps.settings().language)
  readonly plan: PlanStore
  readonly triggers: HomeTriggers
  /** Where pictures (camera stills, photos the user sends) are kept. */
  readonly inbox: string
  private connecting: Promise<void> = Promise.resolve()

  constructor(private deps: HomeDeps) {
    this.inbox = join(deps.dataDir, 'inbox')
    this.plan = new PlanStore(deps.dataDir, () => deps.settings().language)
    this.engine = new HomeEngine({
      dataDir: deps.dataDir,
      settings: () => deps.settings(),
      seal: async (text) => (await deps.host.request({ action: 'secret.seal', text })).message,
      open: async (text) => (await deps.host.request({ action: 'secret.open', text })).message,
      onStatus: (status) => {
        deps.emit({ type: 'home.engine', status })
        this.connecting = this.connecting.then(() => this.followEngine(status.state)).catch(() => undefined)
      }
    })
    this.triggers = new HomeTriggers({
      dataDir: deps.dataDir,
      hub: this.hub,
      launch: (rule, change, name) => deps.launchRule(rule, change, name),
      notify: (title, body, photo) => deps.notify(title, body, photo),
      look: (pictures, question) => deps.look(pictures, question),
      onChange: () => deps.emit({ type: 'home.rules', rules: this.rulesView() }),
      language: () => deps.settings().language
    })
    let lastAutomations = ''
    this.hub.onSnapshot((snapshot) => {
      deps.emit({ type: 'home.snapshot', snapshot })
      // The rules panel lists Home Assistant's automations: tell it when they change (or first appear).
      const automations = JSON.stringify(snapshot.automations)
      if (automations !== lastAutomations) {
        lastAutomations = automations
        deps.emit({ type: 'home.rules', rules: this.rulesView() })
      }
      const placed = autoPlace(this.plan.get(), snapshot.things)
      if (placed !== this.plan.get()) deps.emit({ type: 'home.plan', plan: this.plan.set(placed) })
    })
  }

  start(): void {
    this.triggers.start()
    void this.sync()
  }

  /** Settings changed: start, stop or reconnect the engine as needed. */
  async sync(): Promise<void> {
    await this.engine.sync().catch((error: Error) => console.error('[home] engine:', error.message))
  }

  private async followEngine(state: string): Promise<void> {
    if (state === 'ready') {
      const creds = await this.engine.credentials()
      if (creds && !this.hub.ready) await this.hub.connect(creds.url, creds.token).catch((error: Error) => console.error('[home] hub:', error.message))
    } else if (this.hub.ready || state === 'off' || state === 'missing') {
      this.hub.disconnect()
      this.deps.emit({ type: 'home.snapshot', snapshot: EMPTY_SNAPSHOT })
    }
  }

  async stop(): Promise<void> {
    this.triggers.stop()
    this.hub.disconnect()
    await this.engine.stop()
  }

  rulesView(): HomeRulesView {
    const rules = this.triggers.rules()
    return { automations: this.hub.ready ? this.hub.automations() : [], judgment: rules.judgment, watches: rules.watches }
  }

  // ---------------------------------------------------------------------------
  // Plan

  /** Saves a plan: rooms get their Home Assistant area, and a device moved into another room joins that area. */
  async savePlan(input: HomePlan): Promise<HomePlan> {
    const before = this.plan.get()
    const plan = sanitizePlan(input, this.deps.settings().language)
    if (this.hub.ready) {
      const snapshot = this.hub.snapshot()
      const areaName = new Map(snapshot.areas.map((a) => [a.id, a.name]))
      for (const floor of plan.floors) {
        for (const room of floor.rooms) {
          if (room.areaId && !areaName.has(room.areaId)) room.areaId = null
          if (!room.areaId) room.areaId = await this.hub.ensureArea(room.name).catch(() => null)
          else if (areaName.get(room.areaId) !== room.name) await this.hub.renameArea(room.areaId, room.name).catch(() => undefined)
        }
        const old = new Map(before.floors.flatMap((f) => f.items).map((i) => [i.ref, i]))
        for (const item of floor.items) {
          const was = old.get(item.ref)
          if (was && was.x === item.x && was.y === item.y) continue
          const room = roomAt(floor, [item.x, item.y])
          const thing = snapshot.things.find((t) => t.id === item.ref)
          if (room?.areaId && thing && thing.areaId !== room.areaId) await this.hub.updateThing(thing.id, { areaId: room.areaId }).catch(() => undefined)
        }
      }
    }
    const saved = this.plan.set(plan)
    this.deps.emit({ type: 'home.plan', plan: saved })
    return saved
  }

  async planFromDrawing(path: string, floorId?: string): Promise<HomePlan> {
    const drawing = parseDrawing(await this.deps.readVault(path))
    const { rooms, doors } = planFromDrawing(drawing.elements, this.deps.settings().language)
    if (!rooms.length) throw new PlanError('tool.plan.noRects')
    return this.savePlan(replaceFloorShape(this.plan.get(), floorId, rooms, doors, { kind: 'excalidraw', ref: path }))
  }

  // ---------------------------------------------------------------------------
  // Window requests

  async handle(request: CoordinatorRequest): Promise<unknown> {
    switch (request.method) {
      case 'home.status':
        return this.engine.status()
      case 'home.install':
        void this.engine.install().catch(() => undefined)
        return null
      case 'home.start':
        void this.engine.start().catch(() => undefined)
        return null
      case 'home.stop':
        await this.engine.stop()
        return null
      case 'home.uninstall':
        await this.engine.uninstall()
        return null
      case 'home.connectExternal':
        await this.engine.connectExternalWith(request.url, request.token)
        return null
      case 'home.advanced':
        return this.engine.ownerLogin()
      case 'home.snapshot':
        return this.hub.ready ? this.hub.snapshot() : EMPTY_SNAPSHOT
      case 'home.control':
        await this.hub.control(request.entityId, request.service, request.data)
        return null
      case 'home.thing.update':
        await this.hub.updateThing(request.id, { name: request.name, areaId: request.areaId })
        return null
      case 'home.thing.remove':
        return this.hub.removeThing(request.id)
      case 'home.integrations':
        return this.hub.integrations()
      case 'home.entries':
        return this.hub.entries()
      case 'home.flow.start':
        return this.hub.startFlow(request.domain, this.deps.settings().language)
      case 'home.flow.step':
        return this.hub.stepFlow(request.flowId, request.data, request.menu, this.deps.settings().language)
      case 'home.flow.abort':
        await this.hub.abortFlow(request.flowId)
        return null
      case 'home.entry.remove':
        await this.hub.removeEntry(request.entryId)
        return null
      case 'home.plan.get':
        return this.plan.get()
      case 'home.plan.set':
        return this.savePlan(request.plan)
      case 'home.plan.fromDrawing':
        return this.planFromDrawing(request.path, request.floorId)
      case 'home.camera.snapshot':
        return `data:image/jpeg;base64,${(await this.hub.cameraSnapshot(request.entityId)).toString('base64')}`
      case 'home.rules':
        return this.rulesView()
      case 'home.rule.toggle':
        if (request.kind === 'ha') {
          const automation = this.hub.automations().find((a) => a.id === request.id)
          if (automation) await this.hub.toggleAutomation(automation.entityId, request.enabled)
        } else this.triggers.toggleJudgment(request.id, request.enabled)
        return null
      case 'home.rule.delete':
        if (request.kind === 'ha') await this.hub.deleteAutomation(request.id)
        else if (request.kind === 'watch') this.triggers.stopWatch(request.id)
        else this.triggers.removeJudgment(request.id)
        return null
      default:
        throw new ToolError('tool.error', { data: `Unknown request: ${(request as { method: string }).method}` })
    }
  }

  /** An agent started a flow that needs the window (a QR to scan, a page to open): show it there. */
  showFlow(step: FlowStep): void {
    this.deps.emit({ type: 'home.flow', step })
  }

  /** Saves a still where the agent and the window can both read it. */
  saveStill(entityId: string, jpeg: Buffer): string {
    mkdirSync(this.inbox, { recursive: true })
    const file = join(this.inbox, `${entityId.replace(/\W+/g, '_')}-${Date.now()}.jpg`)
    writeFileSync(file, jpeg)
    return file
  }
}
