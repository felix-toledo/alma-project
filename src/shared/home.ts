// Home automation: the vocabulary shared by the coordinator (Home Assistant client, plan, tools) and the "Casa" window.
// Home Assistant (HA) owns devices, areas, scenes and automations; Alma owns the floor plan and the judgment rules.
import type { DrawingElement } from './excalidraw'
import type { Language } from './i18n/language'
import { translate } from './i18n/messages'

export interface HomeSettings {
  enabled: boolean
  /** managed: Alma runs Home Assistant in its own hidden WSL distro. external: one the user already has. */
  mode: 'managed' | 'external'
  /** external mode: base URL, e.g. http://192.168.1.20:8123 (the token is stored encrypted, never here). */
  externalUrl: string
  /** WSL mirrored networking (needed to discover devices on the LAN). It changes ALL the user's WSL distros. */
  mirrored: boolean
  /** Agent that answers the rules that need judgment; empty = the default agent. */
  agentId: string
}

export type HomeEngineState = 'off' | 'missing' | 'installing' | 'starting' | 'ready' | 'error' | 'unsupported'

export interface HomeEngineStatus {
  state: HomeEngineState
  mode: HomeSettings['mode']
  /** What it is doing while installing or starting. */
  step?: string
  /** 0–1 while installing. */
  progress?: number
  error?: string
  /** Home Assistant's version once it answers. */
  version?: string
  /** Where Home Assistant answers (for camera streams and the "avanzado" button). */
  url?: string
}

export type DeviceKind = 'light' | 'switch' | 'camera' | 'speaker' | 'cover' | 'fan' | 'climate' | 'lock' | 'alarm' | 'sensor' | 'other'

/** Domains Alma can show as a device of its own (everything else is a sensor of some device). */
export const DEVICE_DOMAINS: Record<string, DeviceKind> = {
  light: 'light',
  switch: 'switch',
  input_boolean: 'switch',
  camera: 'camera',
  media_player: 'speaker',
  cover: 'cover',
  fan: 'fan',
  climate: 'climate',
  humidifier: 'climate',
  water_heater: 'climate',
  lock: 'lock',
  alarm_control_panel: 'alarm',
  siren: 'alarm',
  valve: 'other',
  vacuum: 'other',
  lawn_mower: 'other'
}

/** Controlling these always needs the user's approval, whatever the mode (locks, alarms, doors). */
export const SENSITIVE_KINDS: DeviceKind[] = ['lock', 'alarm']

export function isSensitive(kind: DeviceKind, deviceClass?: string): boolean {
  return SENSITIVE_KINDS.includes(kind) || (kind === 'cover' && ['garage', 'gate', 'door'].includes(deviceClass ?? ''))
}

export interface HomeSensor {
  entityId: string
  name: string
  state: string
  unit?: string
  deviceClass?: string
}

/** One thing in the house: a device (or a lone entity) with its main entity and its sensors. */
export interface HomeThing {
  /** HA device id, or the entity id when it has no device. */
  id: string
  name: string
  kind: DeviceKind
  areaId: string | null
  /** The entity that controls it. */
  entityId: string
  state: string
  /** on/off for the things that have it. */
  on: boolean | null
  available: boolean
  /** The attributes that matter (brightness, color, volume, picture…). */
  attrs: Record<string, unknown>
  sensors: HomeSensor[]
  integration?: string
  manufacturer?: string
  model?: string
  deviceClass?: string
}

export interface HomeArea {
  id: string
  name: string
}

export interface HomeScene {
  entityId: string
  name: string
}

export interface HomeAutomation {
  /** The `id` it was saved with in HA (config id). */
  id: string
  entityId: string
  name: string
  enabled: boolean
  lastTriggered: string | null
}

export interface HomeSnapshot {
  things: HomeThing[]
  areas: HomeArea[]
  scenes: HomeScene[]
  automations: HomeAutomation[]
}

const POPULAR_DOMAINS = ['tuya', 'sonoff', 'onvif', 'tplink', 'hue', 'cast', 'wiz', 'shelly', 'esphome', 'xiaomi_miio', 'zha'] as const

/** Integrations that make sense to offer first; the rest of HA's catalog is searchable. Names and hints follow the language. */
export function popularIntegrations(language: Language = 'es'): { domain: string; name: string; hint: string }[] {
  return POPULAR_DOMAINS.map((domain) => ({ domain, name: translate(language, `integration.${domain}.name`), hint: translate(language, `integration.${domain}.hint`) }))
}

export const POPULAR_INTEGRATIONS = popularIntegrations('es')

// ---------------------------------------------------------------------------
// Config flows: HA asks for data step by step (a form per step). The window renders any of them.

export interface FlowField {
  name: string
  type: 'string' | 'password' | 'integer' | 'float' | 'boolean' | 'select' | 'multi_select' | 'unknown'
  required: boolean
  default?: unknown
  options?: { value: string; label: string }[]
  /** Numeric limits, when HA gives them. */
  min?: number
  max?: number
  /** The integration's own wording (Spanish when it has it). */
  label?: string
  hint?: string
}

export interface FlowStep {
  flowId: string
  /** The integration domain. */
  handler: string
  kind: 'form' | 'menu' | 'progress' | 'external' | 'done' | 'abort'
  stepId?: string
  title: string
  description: string
  fields: FlowField[]
  errors: Record<string, string>
  /** menu: the options to pick from. */
  menu?: { id: string; label: string }[]
  /** external: a page the user must open (OAuth); progress: HA is working, ask again in a moment. */
  url?: string
  /** A QR code HA draws as an image (Tuya), as a data URL. */
  qr?: string
  /** done/abort: the result. */
  entryId?: string
  reason?: string
}

export interface HomeIntegration {
  domain: string
  name: string
}

export interface HomeEntry {
  entryId: string
  domain: string
  title: string
  state: string
}

// ---------------------------------------------------------------------------
// The floor plan: Alma's own, drawn from a photo, a sketch or an Excalidraw file. Units are centimetres.

export type Point = [number, number]

export interface PlanRoom {
  id: string
  name: string
  /** The HA area this room is (created with the room). */
  areaId: string | null
  polygon: Point[]
  color?: string
}

/** An opening in a wall, from a to b. */
export interface PlanDoor {
  id: string
  a: Point
  b: Point
}

export interface PlanItem {
  /** A HomeThing id. */
  ref: string
  x: number
  y: number
}

export interface PlanFloor {
  id: string
  name: string
  rooms: PlanRoom[]
  doors: PlanDoor[]
  items: PlanItem[]
}

export interface HomePlan {
  floors: PlanFloor[]
  /** Where the rooms came from, to say so in the window. */
  source?: { kind: 'excalidraw' | 'photo' | 'manual'; ref?: string }
  updatedAt: number
}

export function emptyPlan(language: Language = 'es'): HomePlan {
  return { floors: [{ id: 'piso-1', name: translate(language, 'plan.groundFloor'), rooms: [], doors: [], items: [] }], updatedAt: Date.now() }
}

export const newId = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 8)}`

export function bbox(points: Point[]): { x: number; y: number; w: number; h: number } {
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 }
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** Area-weighted centre of a polygon; falls back to the bounding box centre for degenerate ones. */
export function centroid(polygon: Point[]): Point {
  let area = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]
    const [x2, y2] = polygon[(i + 1) % polygon.length]
    const cross = x1 * y2 - x2 * y1
    area += cross
    cx += (x1 + x2) * cross
    cy += (y1 + y2) * cross
  }
  if (Math.abs(area) < 1e-6) {
    const box = bbox(polygon)
    return [box.x + box.w / 2, box.y + box.h / 2]
  }
  return [cx / (3 * area), cy / (3 * area)]
}

/** Ray casting. */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  const [x, y] = point
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function polygonArea(polygon: Point[]): number {
  let sum = 0
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]
    const [x2, y2] = polygon[(i + 1) % polygon.length]
    sum += x1 * y2 - x2 * y1
  }
  return Math.abs(sum) / 2
}

/** The room a point is in, if any (the smallest when rooms overlap). */
export function roomAt(floor: PlanFloor, point: Point): PlanRoom | undefined {
  return floor.rooms.filter((room) => pointInPolygon(point, room.polygon)).sort((a, b) => polygonArea(a.polygon) - polygonArea(b.polygon))[0]
}

/** A free spot inside a room for a new item: its centre, shifted so several items don't pile up. */
export function spotIn(floor: PlanFloor, room: PlanRoom): Point {
  const [cx, cy] = centroid(room.polygon)
  const taken = floor.items.filter((item) => pointInPolygon([item.x, item.y], room.polygon))
  const box = bbox(room.polygon)
  const step = Math.max(40, Math.min(box.w, box.h) / 5)
  for (let ring = 0; ring < 12; ring++) {
    for (let k = 0; k < Math.max(1, ring * 6); k++) {
      const angle = (k / Math.max(1, ring * 6)) * Math.PI * 2
      const candidate: Point = [cx + Math.cos(angle) * ring * step, cy + Math.sin(angle) * ring * step]
      if (!pointInPolygon(candidate, room.polygon)) continue
      if (taken.every((item) => Math.hypot(item.x - candidate[0], item.y - candidate[1]) >= step * 0.8)) return candidate
    }
  }
  return [cx, cy]
}

/** Keeps polygons sane: at least 3 finite points. */
export function cleanPolygon(raw: unknown): Point[] | null {
  if (!Array.isArray(raw)) return null
  const points: Point[] = []
  for (const p of raw) {
    if (Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) points.push([Math.round(p[0]), Math.round(p[1])])
  }
  return points.length >= 3 ? points : null
}

export function rectPolygon(x: number, y: number, w: number, h: number): Point[] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h]
  ]
}

/** Moves and scales rooms (and their doors) so the whole floor is `target` cm on its longest side, starting at 0,0. */
export function normalizeFloor(rooms: PlanRoom[], doors: PlanDoor[], target = 1200): { rooms: PlanRoom[]; doors: PlanDoor[] } {
  const box = bbox(rooms.flatMap((r) => r.polygon))
  const scale = Math.max(box.w, box.h) > 0 ? target / Math.max(box.w, box.h) : 1
  const move = (p: Point): Point => [Math.round((p[0] - box.x) * scale), Math.round((p[1] - box.y) * scale)]
  return {
    rooms: rooms.map((room) => ({ ...room, polygon: room.polygon.map(move) })),
    doors: doors.map((door) => ({ ...door, a: move(door.a), b: move(door.b) }))
  }
}

/**
 * Rooms from an Excalidraw drawing: every rectangle (or closed line) is a room, named by the text inside it.
 * A big outline that contains other rooms is the house's wall, not a room. Scale is fitted to `target` cm.
 */
export function planFromDrawing(elements: DrawingElement[], language: Language = 'es', target = 1200): { rooms: PlanRoom[]; doors: PlanDoor[] } {
  const live = elements.filter((e) => !e.isDeleted)
  const byId = new Map(live.map((e) => [e.id, e]))
  const shapes: { id: string; polygon: Point[]; box: ReturnType<typeof bbox>; color?: string }[] = []
  for (const e of live) {
    if (e.type === 'rectangle' || e.type === 'diamond') {
      const polygon = e.type === 'rectangle' ? rectPolygon(e.x, e.y, e.width, e.height) : ([[e.x + e.width / 2, e.y], [e.x + e.width, e.y + e.height / 2], [e.x + e.width / 2, e.y + e.height], [e.x, e.y + e.height / 2]] as Point[])
      shapes.push({ id: e.id, polygon, box: bbox(polygon), color: e.backgroundColor && e.backgroundColor !== 'transparent' ? e.backgroundColor : undefined })
    } else if (e.type === 'line') {
      const points = (e as DrawingElement & { points?: Point[] }).points
      if (!points || points.length < 4) continue
      const first = points[0]
      const last = points[points.length - 1]
      if (Math.hypot(first[0] - last[0], first[1] - last[1]) > Math.max(e.width, e.height) * 0.15) continue
      const polygon = cleanPolygon(points.slice(0, -1).map((p) => [e.x + p[0], e.y + p[1]]))
      if (polygon) shapes.push({ id: e.id, polygon, box: bbox(polygon) })
    }
  }
  const texts = live.filter((e) => e.type === 'text' && (e.originalText ?? e.text ?? '').trim())
  const labelOf = (shape: (typeof shapes)[number]): string => {
    const container = byId.get(shape.id)
    const boundId = container?.boundElements?.find((b) => b.type === 'text')?.id
    const bound = boundId ? byId.get(boundId) : undefined
    const pick = bound ?? texts.filter((t) => !t.containerId && pointInPolygon([t.x + t.width / 2, t.y + t.height / 2], shape.polygon)).sort((a, b) => a.y - b.y)[0]
    return (pick?.originalText ?? pick?.text ?? '').replace(/\s+/g, ' ').trim()
  }
  // Shapes that share a wall touch the outline's edge, where point-in-polygon is ambiguous: compare bounding boxes.
  const inside = (outer: (typeof shapes)[number], inner: (typeof shapes)[number]): boolean => {
    const [o, i] = [outer.box, inner.box]
    return inner !== outer && i.x >= o.x - 1 && i.y >= o.y - 1 && i.x + i.w <= o.x + o.w + 1 && i.y + i.h <= o.y + o.h + 1 && i.w * i.h < o.w * o.h
  }
  // The outline of the whole house: contains two or more other shapes.
  const rooms = shapes.filter((shape) => shapes.filter((other) => inside(shape, other)).length < 2)
  let unnamed = 0
  const planRooms: PlanRoom[] = rooms.map((shape) => ({
    id: newId('room'),
    name: labelOf(shape) || translate(language, 'plan.roomN', { n: ++unnamed }),
    areaId: null,
    polygon: shape.polygon.map((p) => [p[0], p[1]] as Point),
    ...(shape.color ? { color: shape.color } : {})
  }))
  return normalizeFloor(planRooms, [], target)
}

/** The first valid JSON object or array in a model's answer (it may wrap it in a code fence or prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]
  const candidates = [fenced, text].filter((c): c is string => !!c)
  for (const candidate of candidates) {
    const start = candidate.search(/[{[]/)
    if (start < 0) continue
    for (let end = candidate.length; end > start; end--) {
      const ch = candidate[end - 1]
      if (ch !== '}' && ch !== ']') continue
      try {
        return JSON.parse(candidate.slice(start, end))
      } catch {
        // keep shrinking
      }
    }
  }
  throw new Error('The answer has no JSON.')
}

/** What a vision model returns when it reads a floor plan photo, on a 0–100 grid (x to the right, y down). */
export interface VisionPlan {
  rooms: { name: string; polygon: Point[] }[]
  doors?: { a: Point; b: Point }[]
}

/** `aspect` is the picture's width / height: the model answers in percent of each side, so x is stretched by it. */
export function planFromVision(data: unknown, aspect = 1, language: Language = 'es', target = 1200): { rooms: PlanRoom[]; doors: PlanDoor[] } {
  const raw = data as Partial<VisionPlan> | null
  const stretch = (p: Point): Point => [p[0] * aspect, p[1]]
  const rooms: PlanRoom[] = []
  for (const room of raw?.rooms ?? []) {
    const polygon = cleanPolygon(room?.polygon)?.map(stretch)
    if (polygon) rooms.push({ id: newId('room'), name: String(room.name ?? '').trim() || translate(language, 'plan.roomN', { n: rooms.length + 1 }), areaId: null, polygon })
  }
  if (!rooms.length) throw new Error('No room was recognized in the image.')
  const doors: PlanDoor[] = []
  for (const door of raw?.doors ?? []) {
    if (Array.isArray(door?.a) && Array.isArray(door?.b) && [...door.a, ...door.b].every(Number.isFinite)) doors.push({ id: newId('door'), a: stretch(door.a), b: stretch(door.b) })
  }
  return normalizeFloor(rooms, doors, target)
}

// ---------------------------------------------------------------------------
// Rules

/** A rule that needs judgment: when something happens, Alma wakes up, looks, and decides. */
export interface JudgmentRule {
  id: string
  name: string
  enabled: boolean
  /** The entity that wakes Alma and the state it must go to (any change when `to` is empty). */
  entityId: string
  to?: string
  /** "HH:MM"–"HH:MM" local; may cross midnight. Empty = always. */
  between?: [string, string]
  /** Minimum minutes between two wake-ups. */
  cooldownMin: number
  /** What Alma must do (she can use every tool, camera included). */
  prompt: string
  createdBy: 'user' | 'agent'
  lastFiredAt?: number
}

export interface CameraWatch {
  id: string
  entityId: string
  cameraName: string
  /** What to look for, in plain words. */
  condition: string
  everySec: number
  /** Epoch ms when it stops by itself. */
  until: number
  startedAt: number
  checks: number
  /** Keeps going after the first match. */
  repeat: boolean
  lastNote?: string
}

export interface HomeRules {
  judgment: JudgmentRule[]
  watches: CameraWatch[]
}

/** True when `now` falls in the "HH:MM"–"HH:MM" window (which may wrap past midnight). */
export function inWindow(between: [string, string] | undefined, now: Date): boolean {
  if (!between?.[0] || !between[1]) return true
  const minutes = (hm: string): number => {
    const [h, m] = hm.split(':').map(Number)
    return h * 60 + (m || 0)
  }
  const current = now.getHours() * 60 + now.getMinutes()
  const from = minutes(between[0])
  const to = minutes(between[1])
  return from <= to ? current >= from && current < to : current >= from || current < to
}

/** Should this state change wake the rule right now? */
export function ruleMatches(rule: JudgmentRule, change: { entityId: string; to: string | null; from: string | null }, now: Date): boolean {
  if (!rule.enabled || rule.entityId !== change.entityId) return false
  if (change.to === change.from) return false
  if (rule.to && rule.to !== change.to) return false
  if (!inWindow(rule.between, now)) return false
  if (rule.lastFiredAt && now.getTime() - rule.lastFiredAt < rule.cooldownMin * 60_000) return false
  return true
}
