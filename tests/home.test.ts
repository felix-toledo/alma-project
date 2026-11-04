import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DrawingElement } from '../src/shared/excalidraw'
import {
  centroid,
  emptyPlan,
  extractJson,
  inWindow,
  isSensitive,
  planFromDrawing,
  planFromVision,
  pointInPolygon,
  rectPolygon,
  ruleMatches,
  spotIn,
  type HomeSettings,
  type HomeThing,
  type JudgmentRule
} from '../src/shared/home'
import { mapFields, nestData } from '../src/coordinator/home/flow'
import { buildThings, findThings, fold, type RegDevice, type RegEntity } from '../src/coordinator/home/model'
import { applyPlanOp, autoPlace, describePlan, PlanError, PlanStore, replaceFloorShape, sanitizePlan } from '../src/coordinator/home/plan'
import type { StateObject } from '../src/coordinator/home/ha'

// Loaded once up front: the first import pulls in the model SDKs, which is slow on a busy machine.
const homeToolsModule = await import('../src/coordinator/tools/home')
const visionModule = await import('../src/coordinator/vision')

const el = (id: string, type: string, x: number, y: number, width: number, height: number, extra: Partial<DrawingElement> = {}): DrawingElement => ({ id, type, x, y, width, height, ...extra })

describe('geometría del plano', () => {
  it('centroide y punto en polígono', () => {
    const room = rectPolygon(0, 0, 400, 200)
    expect(centroid(room)).toEqual([200, 100])
    expect(pointInPolygon([50, 50], room)).toBe(true)
    expect(pointInPolygon([500, 50], room)).toBe(false)
  })

  it('spotIn reparte varios dispositivos sin amontonarlos', () => {
    const plan = emptyPlan()
    const floor = plan.floors[0]
    floor.rooms.push({ id: 'r', name: 'Sala', areaId: null, polygon: rectPolygon(0, 0, 400, 400) })
    const spots: number[][] = []
    for (let i = 0; i < 4; i++) {
      const [x, y] = spotIn(floor, floor.rooms[0])
      expect(pointInPolygon([x, y], floor.rooms[0].polygon)).toBe(true)
      spots.push([x, y])
      floor.items.push({ ref: `t${i}`, x, y })
    }
    const distinct = new Set(spots.map((s) => s.join(',')))
    expect(distinct.size).toBe(4)
  })

  it('un dibujo de Excalidraw se vuelve habitaciones con su nombre y la silueta de la casa se descarta', () => {
    const elements: DrawingElement[] = [
      el('casa', 'rectangle', 0, 0, 800, 500),
      el('cocina', 'rectangle', 0, 0, 400, 300, { boundElements: [{ id: 't1', type: 'text' }] }),
      el('t1', 'text', 150, 130, 80, 30, { text: 'Cocina', originalText: 'Cocina', containerId: 'cocina' }),
      el('living', 'rectangle', 400, 0, 400, 500),
      el('t2', 'text', 560, 230, 80, 30, { text: 'Living', originalText: 'Living' }),
      el('x', 'rectangle', 0, 300, 400, 200)
    ]
    const { rooms } = planFromDrawing(elements)
    expect(rooms.map((r) => r.name).sort()).toEqual(['Cocina', 'Habitación 1', 'Living'])
    // Fitted to 12 m on the longest side.
    const xs = rooms.flatMap((r) => r.polygon.map((p) => p[0]))
    expect(Math.max(...xs) - Math.min(...xs)).toBe(1200)
  })

  it('un plano leído de una imagen se escala y exige habitaciones', () => {
    const { rooms, doors } = planFromVision({ rooms: [{ name: 'Baño', polygon: [[0, 0], [50, 0], [50, 100], [0, 100]] }, { name: 'Dormitorio', polygon: [[50, 0], [100, 0], [100, 100], [50, 100]] }], doors: [{ a: [50, 40], b: [50, 60] }] })
    expect(rooms).toHaveLength(2)
    expect(doors).toHaveLength(1)
    expect(() => planFromVision({ rooms: [] })).toThrow(/ninguna habitación/)
  })

  it('extractJson saca el JSON de una respuesta con texto y vallas', () => {
    expect(extractJson('Claro:\n```json\n{"a": [1, 2]}\n```\nlisto')).toEqual({ a: [1, 2] })
    expect(extractJson('{"match": false}')).toEqual({ match: false })
    expect(() => extractJson('sin json')).toThrow()
  })
})

describe('reglas con criterio', () => {
  const rule: JudgmentRule = { id: 'r', name: 'Patio', enabled: true, entityId: 'binary_sensor.patio', to: 'on', between: ['22:00', '07:00'], cooldownMin: 10, prompt: 'mirá', createdBy: 'user' }
  const at = (h: number, m = 0): Date => new Date(2026, 9, 28, h, m)

  it('la franja horaria cruza la medianoche', () => {
    expect(inWindow(['22:00', '07:00'], at(23))).toBe(true)
    expect(inWindow(['22:00', '07:00'], at(3))).toBe(true)
    expect(inWindow(['22:00', '07:00'], at(12))).toBe(false)
    expect(inWindow(undefined, at(12))).toBe(true)
  })

  it('despierta solo con el cambio, la franja, el estado y fuera del enfriamiento', () => {
    const change = { entityId: 'binary_sensor.patio', from: 'off', to: 'on' }
    expect(ruleMatches(rule, change, at(23))).toBe(true)
    expect(ruleMatches(rule, change, at(12))).toBe(false)
    expect(ruleMatches(rule, { ...change, to: 'off', from: 'on' }, at(23))).toBe(false)
    expect(ruleMatches(rule, { ...change, entityId: 'otro' }, at(23))).toBe(false)
    expect(ruleMatches({ ...rule, enabled: false }, change, at(23))).toBe(false)
    expect(ruleMatches({ ...rule, lastFiredAt: at(22, 55).getTime() }, change, at(23))).toBe(false)
    expect(ruleMatches({ ...rule, lastFiredAt: at(22, 30).getTime() }, change, at(23))).toBe(true)
  })

  it('lo sensible', () => {
    expect(isSensitive('lock')).toBe(true)
    expect(isSensitive('cover', 'garage')).toBe(true)
    expect(isSensitive('cover', 'blind')).toBe(false)
    expect(isSensitive('light')).toBe(false)
  })
})

const state = (entity_id: string, s: string, attributes: Record<string, unknown> = {}): StateObject => ({ entity_id, state: s, attributes })
const device = (id: string, name: string, area: string | null = null, extra: Partial<RegDevice> = {}): RegDevice => ({ id, name, name_by_user: null, area_id: area, manufacturer: null, model: null, disabled_by: null, ...extra })
const entity = (entity_id: string, device_id: string | null, extra: Partial<RegEntity> = {}): RegEntity => ({ entity_id, device_id, area_id: null, platform: 'demo', disabled_by: null, hidden_by: null, entity_category: null, ...extra })

describe('cosas de la casa a partir de Home Assistant', () => {
  const states = new Map(
    [
      state('light.techo', 'on', { friendly_name: 'Luz techo', brightness: 128, supported_color_modes: ['color_temp'] }),
      state('sensor.techo_potencia', ' 4.5', { friendly_name: 'Potencia', unit_of_measurement: 'W' }),
      state('switch.regleta_1', 'off', { friendly_name: 'Regleta 1' }),
      state('switch.regleta_2', 'on', { friendly_name: 'Regleta 2' }),
      state('camera.patio', 'idle', { friendly_name: 'Patio', entity_picture: '/api/camera_proxy/camera.patio?token=abc' }),
      state('light.oculta', 'on', { friendly_name: 'Oculta' }),
      state('light.diag', 'on', { friendly_name: 'Diag' }),
      state('lock.puerta', 'locked', { friendly_name: 'Puerta' }),
      state('light.suelta', 'unavailable', { friendly_name: 'Suelta' }),
      state('media_player.sala', 'playing', { friendly_name: 'Sala', volume_level: 0.4 })
    ].map((s) => [s.entity_id, s])
  )
  const devices = [device('d1', 'Foco techo', 'cocina', { manufacturer: 'Moes' }), device('d2', 'Regleta', 'living'), device('d3', 'Cámara patio'), device('d4', 'Cerradura'), device('d5', 'Apagado', null, { disabled_by: 'user' })]
  const entities = [
    entity('light.techo', 'd1'),
    entity('sensor.techo_potencia', 'd1'),
    entity('switch.regleta_1', 'd2'),
    entity('switch.regleta_2', 'd2'),
    entity('camera.patio', 'd3'),
    entity('light.oculta', 'd1', { hidden_by: 'user' }),
    entity('light.diag', 'd1', { entity_category: 'diagnostic' }),
    entity('lock.puerta', 'd4'),
    entity('light.suelta', null, { area_id: 'cocina' })
  ]
  const things = buildThings(states, [], devices, entities)

  it('un dispositivo con una sola entidad es esa entidad, con sus sensores', () => {
    const light = things.find((t) => t.entityId === 'light.techo')!
    expect(light.id).toBe('d1')
    expect(light.name).toBe('Foco techo')
    expect(light.on).toBe(true)
    expect(light.areaId).toBe('cocina')
    expect(light.manufacturer).toBe('Moes')
    expect(light.sensors.map((s) => s.name)).toEqual(['Potencia'])
    expect(light.attrs).toEqual({ brightness: 128, supported_color_modes: ['color_temp'] })
  })

  it('uno con varias entidades las muestra por separado', () => {
    const plugs = things.filter((t) => t.kind === 'switch')
    expect(plugs.map((t) => t.id).sort()).toEqual(['switch.regleta_1', 'switch.regleta_2'])
    expect(plugs.map((t) => t.name).sort()).toEqual(['Regleta 1', 'Regleta 2'])
    expect(plugs.every((t) => t.areaId === 'living')).toBe(true)
  })

  it('incluye lo que tiene estado aunque no esté en el registro (YAML, demos)', () => {
    const speaker = things.find((t) => t.entityId === 'media_player.sala')!
    expect(speaker.kind).toBe('speaker')
    expect(speaker.on).toBe(true)
    expect(speaker.attrs.volume_level).toBe(0.4)
  })

  it('oculta lo oculto, lo de diagnóstico y lo deshabilitado; incluye las entidades sueltas', () => {
    expect(things.some((t) => t.entityId === 'light.oculta' || t.entityId === 'light.diag')).toBe(false)
    const loose = things.find((t) => t.entityId === 'light.suelta')!
    expect(loose.available).toBe(false)
    expect(loose.areaId).toBe('cocina')
    expect(things.find((t) => t.entityId === 'lock.puerta')?.on).toBe(false)
    expect(things.find((t) => t.entityId === 'camera.patio')?.attrs.entity_picture).toContain('camera_proxy')
  })

  it('encuentra lo que dice la gente', () => {
    const areas = [{ id: 'cocina', name: 'Cocina' }, { id: 'living', name: 'Living' }]
    expect(findThings(things, areas, 'la luz de la cocina').map((t) => t.entityId)).toEqual(['light.techo', 'light.suelta'])
    expect(findThings(things, areas, 'enchufes del living')).toHaveLength(2)
    expect(findThings(things, areas, 'cámara').map((t) => t.entityId)).toEqual(['camera.patio'])
    expect(findThings(things, areas, 'ventilador')).toHaveLength(0)
    expect(fold('Cámara Ñandú')).toBe('camara nandu')
  })
})

describe('plan: operaciones', () => {
  const things: HomeThing[] = [{ id: 'd1', name: 'Foco', kind: 'light', areaId: 'cocina', entityId: 'light.foco', state: 'on', on: true, available: true, attrs: {}, sensors: [] }]
  const base = (): ReturnType<typeof emptyPlan> => {
    let plan = emptyPlan()
    plan = applyPlanOp(plan, { op: 'add_room', name: 'Cocina', rect: [0, 0, 400, 300] })
    plan = applyPlanOp(plan, { op: 'add_room', name: 'Living', rect: [400, 0, 500, 300] })
    return plan
  }

  it('agrega, renombra, ubica y quita', () => {
    let plan = base()
    expect(plan.floors[0].rooms.map((r) => r.name)).toEqual(['Cocina', 'Living'])
    plan = applyPlanOp(plan, { op: 'rename_room', room: 'living', name: 'Sala' }, things)
    plan = applyPlanOp(plan, { op: 'place', ref: 'light.foco', room: 'cocina' }, things)
    expect(plan.floors[0].items[0].ref).toBe('d1')
    expect(pointInPolygon([plan.floors[0].items[0].x, plan.floors[0].items[0].y], plan.floors[0].rooms[0].polygon)).toBe(true)
    // Placing again moves it, it doesn't duplicate it.
    plan = applyPlanOp(plan, { op: 'place', ref: 'd1', room: 'sala' }, things)
    expect(plan.floors[0].items).toHaveLength(1)
    expect(describePlan(plan, things)).toContain('Foco [light]')
    plan = applyPlanOp(plan, { op: 'remove_room', room: 'sala' }, things)
    expect(plan.floors[0].items).toHaveLength(0)
  })

  it('rechaza lo inválido con mensajes claros', () => {
    const plan = base()
    expect(() => applyPlanOp(plan, { op: 'add_room', name: 'cocina', rect: [0, 0, 10, 10] })).toThrow(PlanError)
    expect(() => applyPlanOp(plan, { op: 'add_room', name: 'X' })).toThrow(/Falta la forma/)
    expect(() => applyPlanOp(plan, { op: 'rename_room', room: 'garage', name: 'G' })).toThrow(/No existe la habitación/)
    expect(() => applyPlanOp(plan, { op: 'remove_floor', floor: 'piso-1' })).toThrow(/al menos un piso/)
  })

  it('reemplazar las habitaciones conserva el área de HA de las que siguen con el mismo nombre', () => {
    let plan = base()
    plan.floors[0].rooms[0].areaId = 'area_cocina'
    const next = replaceFloorShape(plan, undefined, [{ id: 'n', name: 'COCINA', areaId: null, polygon: rectPolygon(0, 0, 100, 100) }], [], { kind: 'photo' })
    expect(next.floors[0].rooms[0].areaId).toBe('area_cocina')
    expect(next.source?.kind).toBe('photo')
  })

  it('ubica solo los dispositivos que ya tienen habitación', () => {
    let plan = base()
    plan.floors[0].rooms[0].areaId = 'cocina'
    const placed = autoPlace(plan, [...things, { ...things[0], id: 'd2', areaId: null }])
    expect(placed.floors[0].items.map((i) => i.ref)).toEqual(['d1'])
    expect(autoPlace(placed, things)).toBe(placed)
  })

  it('sanitizePlan arregla lo roto y siempre deja un piso', () => {
    expect(sanitizePlan(null).floors).toHaveLength(1)
    const plan = sanitizePlan({ floors: [{ id: 'a', name: '', rooms: [{ id: 'r', name: '', polygon: [[0, 0], [1, 1]] }, { id: 'r2', name: 'Ok', polygon: [[0, 0], [10, 0], [10, 10]] }], items: [{ ref: 'x', x: 1.4, y: 2 }, { ref: 'x', x: 5, y: 5 }, { ref: 3 }] }] })
    expect(plan.floors[0].rooms.map((r) => r.name)).toEqual(['Ok'])
    expect(plan.floors[0].items).toEqual([{ ref: 'x', x: 1, y: 2 }])
    expect(plan.floors[0].name).toBe('Piso 1')
  })

  describe('guardado', () => {
    let dir: string
    beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'alma-plan-'))))
    afterEach(() => rmSync(dir, { recursive: true, force: true }))
    it('persiste entre arranques', () => {
      const store = new PlanStore(dir)
      store.set(base())
      expect(new PlanStore(dir).get().floors[0].rooms).toHaveLength(2)
    })
  })
})

describe('formularios de Home Assistant', () => {
  it('traduce el esquema de un paso a campos', () => {
    const { fields, qr } = mapFields(
      [
        { name: 'user_code', type: 'string', required: true, default: '' },
        { name: 'password', selector: { text: { type: 'password' } }, required: true },
        { name: 'port', type: 'integer', required: true, default: 80, valueMin: 1, valueMax: 65535 },
        { name: 'ratio', selector: { number: { step: 0.5, min: 0, max: 3 } } },
        { name: 'auto', type: 'boolean', default: true },
        { name: 'mode', selector: { select: { options: [{ value: 'a', label: 'Modo A' }, 'b'] } }, required: true },
        { name: 'sections', type: 'expandable', schema: [{ name: 'host', type: 'string' }] },
        { name: 'QR', selector: { qr_code: { data: 'tuyaSmart--qr--123' } } }
      ],
      () => undefined
    )
    expect(fields.map((f) => [f.name, f.type, f.required])).toEqual([
      ['user_code', 'string', true],
      ['password', 'password', true],
      ['port', 'integer', true],
      ['ratio', 'float', false],
      ['auto', 'boolean', false],
      ['mode', 'select', true],
      ['sections.host', 'string', false]
    ])
    expect(fields[5].options).toEqual([{ value: 'a', label: 'Modo A' }, { value: 'b', label: 'b' }])
    expect(qr).toBe('tuyaSmart--qr--123')
  })

  it('anida los campos de una sección', () => {
    expect(nestData({ a: 1, 'sec.host': 'x', 'sec.port': 2 })).toEqual({ a: 1, sec: { host: 'x', port: 2 } })
  })
})

describe('herramientas del agente', () => {
  // A tiny fake of the service the tools talk to, with a few things, to check what they ask Home Assistant for.
  const things: HomeThing[] = [
    { id: 'l1', name: 'Luz techo', kind: 'light', areaId: 'cocina', entityId: 'light.techo', state: 'off', on: false, available: true, attrs: {}, sensors: [] },
    { id: 'l2', name: 'Luz mesada', kind: 'light', areaId: 'cocina', entityId: 'light.mesada', state: 'off', on: false, available: true, attrs: {}, sensors: [] },
    { id: 'l3', name: 'Luz cama', kind: 'light', areaId: 'dorm', entityId: 'light.cama', state: 'off', on: false, available: true, attrs: {}, sensors: [] },
    { id: 'k1', name: 'Puerta', kind: 'lock', areaId: null, entityId: 'lock.puerta', state: 'locked', on: false, available: true, attrs: {}, sensors: [] },
    { id: 'c1', name: 'Cámara patio', kind: 'camera', areaId: null, entityId: 'camera.patio', state: 'idle', on: null, available: true, attrs: {}, sensors: [] }
  ]
  const areas = [{ id: 'cocina', name: 'Cocina' }, { id: 'dorm', name: 'Dormitorio' }]
  const calls: unknown[][] = []
  const hub = {
    ready: true,
    snapshot: () => ({ things, areas, scenes: [], automations: [] }),
    find: (q: string) => findThings(things, areas, q),
    thing: (id: string) => things.find((t) => t.id === id),
    control: vi.fn(async (...args: unknown[]) => void calls.push(args)),
    callService: vi.fn(async () => undefined),
    cameraSnapshot: vi.fn(async () => Buffer.from('jpeg')),
    saveStill: vi.fn(() => 'still.jpg')
  }
  const settings = { home: { enabled: true } as HomeSettings }
  const ctx = (): never => ({ settings, home: { hub, engine: { status: () => ({ state: 'ready' }) }, rulesView: () => ({ automations: [], judgment: [], watches: [] }) } }) as never

  beforeEach(() => {
    calls.length = 0
    hub.control.mockClear()
  })

  it('home_control prende lo que se pidió, sin preguntar', async () => {
    const { homeControlTool } = homeToolsModule
    const parsed = homeControlTool.schema.parse({ target: 'luz de la cama', action: 'on', brightness: 30, temperature: 'calida' })
    const result = await homeControlTool.run(parsed, ctx())
    expect(calls).toEqual([['light.cama', 'light/turn_on', { brightness_pct: 30, color_temp_kelvin: 2700 }]])
    expect(result).toContain('Luz cama')
    expect(homeControlTool.risk).toBe('home')
  })

  it('pide aclarar si hay varias y actúa sobre todas con all', async () => {
    const { homeControlTool } = homeToolsModule
    await expect(homeControlTool.run(homeControlTool.schema.parse({ target: 'luces de la cocina', action: 'off' }), ctx())).rejects.toThrow(/coincide con 2/)
    await homeControlTool.run(homeControlTool.schema.parse({ target: 'luces de la cocina', action: 'off', all: true }), ctx())
    expect(calls.map((c) => c[0])).toEqual(['light.techo', 'light.mesada'])
    expect(calls.every((c) => c[1] === 'light/turn_off')).toBe(true)
  })

  it('no toca cerraduras con home_control y las deja a la herramienta que pide aprobación', async () => {
    const { homeControlTool, homeSecureControlTool } = homeToolsModule
    await expect(homeControlTool.run(homeControlTool.schema.parse({ target: 'puerta', action: 'off' }), ctx())).rejects.toThrow(/home_secure_control/)
    expect(hub.control).not.toHaveBeenCalled()
    expect(homeSecureControlTool.risk).toBe('publish')
    await homeSecureControlTool.run(homeSecureControlTool.schema.parse({ target: 'puerta', action: 'unlock' }), ctx())
    expect(calls).toEqual([['lock.puerta', 'lock/unlock']])
  })

  it('con la domótica apagada o sin conexión explica qué hacer', async () => {
    const { homeOverviewTool, homeControlTool } = homeToolsModule
    await expect(homeOverviewTool.run({}, { settings: { home: { enabled: false } } } as never)).rejects.toThrow(/apagada/)
    const offline = { settings, home: { hub: { ready: false }, engine: { status: () => ({ state: 'missing' }) } } } as never
    await expect(homeControlTool.run(homeControlTool.schema.parse({ target: 'x', action: 'on' }), offline)).rejects.toThrow(/no está conectada/)
  })

  it('camera_photo manda la foto por Telegram sin pasar por la visión', async () => {
    const { cameraPhotoTool } = homeToolsModule
    const sent: Buffer[] = []
    const context = { ...(ctx() as object), sendTelegramPhoto: async (jpeg: Buffer) => (sent.push(jpeg), true) } as never
    const home = (context as { home: Record<string, unknown> }).home
    home.hub = hub
    home.saveStill = hub.saveStill
    expect(await cameraPhotoTool.run(cameraPhotoTool.schema.parse({ camera: 'patio' }), context)).toMatch(/enviada por Telegram/)
    expect(sent).toHaveLength(1)
  })

  it('home_overview agrupa por habitación', async () => {
    const { homeOverviewTool } = homeToolsModule
    const text = await homeOverviewTool.run({}, ctx())
    expect(text).toMatch(/Cocina \(2\)/)
    expect(text).toMatch(/Dormitorio \(1\)/)
    expect(text).toMatch(/Sin habitación \(2\)/)
  })
})

describe('imágenes y motor', () => {
  it('lee el tamaño de PNG, GIF y JPEG por la cabecera', async () => {
    const { imageSize } = visionModule
    const png = Buffer.alloc(32)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
    png.write('IHDR', 12, 'latin1')
    png.writeUInt32BE(800, 16)
    png.writeUInt32BE(520, 20)
    expect(imageSize(png)).toEqual({ width: 800, height: 520 })
    const gif = Buffer.alloc(16)
    gif.write('GIF89a', 0, 'latin1')
    gif.writeUInt16LE(64, 6)
    gif.writeUInt16LE(48, 8)
    expect(imageSize(gif)).toEqual({ width: 64, height: 48 })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01])
    expect(imageSize(jpeg)).toEqual({ width: 640, height: 480 })
    expect(imageSize(Buffer.from('no es una imagen'))).toBeNull()
  })

  it('un plano leído de una foto apaisada conserva las proporciones', () => {
    const wide = planFromVision({ rooms: [{ name: 'A', polygon: [[0, 0], [100, 0], [100, 100], [0, 100]] }] }, 2)
    const xs = wide.rooms[0].polygon.map((p) => p[0])
    const ys = wide.rooms[0].polygon.map((p) => p[1])
    expect(Math.max(...xs) / Math.max(...ys)).toBeCloseTo(2, 1)
  })

  it('la configuración del motor incluye las reglas, los modos y el puerto', async () => {
    const { managedConfig } = await import('../src/coordinator/home/engine')
    const yaml = managedConfig(18123, 'America/Asuncion')
    expect(yaml).toContain('server_port: 18123')
    expect(yaml).toContain('time_zone: America/Asuncion')
    for (const file of ['automations', 'scenes', 'scripts']) expect(yaml).toContain(`!include ${file}.yaml`)
    expect(yaml).toContain('default_config:')
    expect(yaml).toContain('ffmpeg_bin: /usr/local/bin/alma-ffmpeg')
  })

  it('decodeWsl entiende el UTF-16 de wsl.exe y el UTF-8 de Linux', async () => {
    const { decodeWsl } = await import('../src/coordinator/home/engine')
    expect(decodeWsl(Buffer.from('alma-home\r\n', 'utf16le'))).toBe('alma-home\r\n')
    expect(decodeWsl(Buffer.from('listo ñ', 'utf8'))).toBe('listo ñ')
  })
})
