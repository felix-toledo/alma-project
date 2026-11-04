// The floor plan: Alma's own map of the house. Saved next to the data, edited by the window and by agents through the
// same operations, so both always leave a valid plan.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bbox,
  cleanPolygon,
  emptyPlan,
  newId,
  pointInPolygon,
  rectPolygon,
  roomAt,
  spotIn,
  type HomePlan,
  type HomeThing,
  type PlanDoor,
  type PlanFloor,
  type PlanRoom,
  type Point
} from '../../shared/home'
import type { Language } from '../../shared/i18n/language'
import { translate } from '../../shared/i18n/messages'
import { ToolError } from '../tools/types'
import { fold } from './model'

export class PlanError extends ToolError {}

/** Whatever was loaded or sent becomes a valid plan: at least one floor, clean polygons, no duplicate ids. */
export function sanitizePlan(raw: unknown, language: Language = 'es'): HomePlan {
  const input = raw as Partial<HomePlan> | null
  const floors: PlanFloor[] = []
  const seen = new Set<string>()
  const unique = (id: unknown, prefix: string): string => {
    let value = typeof id === 'string' && id && !seen.has(id) ? id : newId(prefix)
    while (seen.has(value)) value = newId(prefix)
    seen.add(value)
    return value
  }
  for (const floor of input?.floors ?? []) {
    const rooms: PlanRoom[] = []
    for (const room of floor?.rooms ?? []) {
      const polygon = cleanPolygon(room?.polygon)
      if (!polygon) continue
      rooms.push({ id: unique(room.id, 'room'), name: String(room.name ?? '').trim() || translate(language, 'plan.roomN', { n: rooms.length + 1 }), areaId: typeof room.areaId === 'string' ? room.areaId : null, polygon, ...(room.color ? { color: String(room.color) } : {}) })
    }
    const doors: PlanDoor[] = []
    for (const door of floor?.doors ?? []) {
      if (Array.isArray(door?.a) && Array.isArray(door?.b) && [...door.a, ...door.b].every(Number.isFinite)) doors.push({ id: unique(door.id, 'door'), a: [door.a[0], door.a[1]], b: [door.b[0], door.b[1]] })
    }
    const placed = new Set<string>()
    const items = (floor?.items ?? []).filter((item) => {
      if (typeof item?.ref !== 'string' || !Number.isFinite(item.x) || !Number.isFinite(item.y) || placed.has(item.ref)) return false
      placed.add(item.ref)
      return true
    })
    floors.push({ id: unique(floor?.id, 'piso'), name: String(floor?.name ?? '').trim() || translate(language, 'plan.floorN', { n: floors.length + 1 }), rooms, doors, items: items.map((i) => ({ ref: i.ref, x: Math.round(i.x), y: Math.round(i.y) })) })
  }
  if (!floors.length) return emptyPlan(language)
  return { floors, ...(input?.source ? { source: input.source } : {}), updatedAt: Date.now() }
}

export class PlanStore {
  private file: string
  private plan: HomePlan

  constructor(
    dataDir: string,
    private language: () => Language = () => 'es'
  ) {
    const dir = join(dataDir, 'home')
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'plan.json')
    this.plan = existsSync(this.file) ? this.load() : emptyPlan(this.language())
  }

  private load(): HomePlan {
    try {
      return sanitizePlan(JSON.parse(readFileSync(this.file, 'utf8')), this.language())
    } catch {
      return emptyPlan(this.language())
    }
  }

  get(): HomePlan {
    return this.plan
  }

  set(plan: HomePlan): HomePlan {
    this.plan = sanitizePlan(plan, this.language())
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.plan, null, 2), 'utf8')
    renameSync(tmp, this.file)
    return this.plan
  }
}

// ---------------------------------------------------------------------------
// Operations (what a tool or the window asks for). They edit a copy and return it.

export type PlanOp =
  | { op: 'add_floor'; name: string }
  | { op: 'rename_floor'; floor: string; name: string }
  | { op: 'remove_floor'; floor: string }
  | { op: 'add_room'; floor?: string; name: string; rect?: [number, number, number, number]; polygon?: Point[] }
  | { op: 'rename_room'; floor?: string; room: string; name: string }
  | { op: 'set_room_shape'; floor?: string; room: string; rect?: [number, number, number, number]; polygon?: Point[] }
  | { op: 'remove_room'; floor?: string; room: string }
  | { op: 'add_door'; floor?: string; a: Point; b: Point }
  | { op: 'place'; floor?: string; ref: string; room?: string; x?: number; y?: number }
  | { op: 'unplace'; ref: string }

export function findFloor(plan: HomePlan, key?: string): PlanFloor {
  if (!key) return plan.floors[0]
  const wanted = fold(key)
  const floor = plan.floors.find((f) => f.id === key || fold(f.name) === wanted) ?? plan.floors.find((f) => fold(f.name).includes(wanted))
  if (!floor) throw new PlanError('tool.plan.noFloor', { key, names: plan.floors.map((f) => f.name).join(', ') })
  return floor
}

export function findRoom(floor: PlanFloor, key: string): PlanRoom {
  const wanted = fold(key)
  const room = floor.rooms.find((r) => r.id === key || fold(r.name) === wanted) ?? floor.rooms.find((r) => fold(r.name).includes(wanted))
  if (!room) throw floor.rooms.length ? new PlanError('tool.plan.noRoom', { key, floor: floor.name, names: floor.rooms.map((r) => r.name).join(', ') }) : new PlanError('tool.plan.noRoomNone', { key, floor: floor.name })
  return room
}

function shapeOf(op: { rect?: [number, number, number, number]; polygon?: Point[] }): Point[] {
  if (op.polygon) {
    const polygon = cleanPolygon(op.polygon)
    if (!polygon) throw new PlanError('tool.plan.polygon')
    return polygon
  }
  if (op.rect && op.rect.every(Number.isFinite) && op.rect[2] > 0 && op.rect[3] > 0) return rectPolygon(...op.rect)
  throw new PlanError('tool.plan.shape')
}

export function applyPlanOp(source: HomePlan, op: PlanOp, things: HomeThing[] = [], language: Language = 'es'): HomePlan {
  const plan = structuredClone(source)
  switch (op.op) {
    case 'add_floor':
      plan.floors.push({ id: newId('piso'), name: op.name.trim() || translate(language, 'plan.floorN', { n: plan.floors.length + 1 }), rooms: [], doors: [], items: [] })
      break
    case 'rename_floor':
      findFloor(plan, op.floor).name = op.name.trim()
      break
    case 'remove_floor': {
      if (plan.floors.length === 1) throw new PlanError('tool.plan.lastFloor')
      const floor = findFloor(plan, op.floor)
      plan.floors = plan.floors.filter((f) => f !== floor)
      break
    }
    case 'add_room': {
      const floor = findFloor(plan, op.floor)
      if (floor.rooms.some((r) => fold(r.name) === fold(op.name))) throw new PlanError('tool.plan.roomExists', { name: op.name, floor: floor.name })
      floor.rooms.push({ id: newId('room'), name: op.name.trim(), areaId: null, polygon: shapeOf(op) })
      break
    }
    case 'rename_room':
      findRoom(findFloor(plan, op.floor), op.room).name = op.name.trim()
      break
    case 'set_room_shape':
      findRoom(findFloor(plan, op.floor), op.room).polygon = shapeOf(op)
      break
    case 'remove_room': {
      const floor = findFloor(plan, op.floor)
      const room = findRoom(floor, op.room)
      floor.rooms = floor.rooms.filter((r) => r !== room)
      floor.items = floor.items.filter((i) => !pointInPolygon([i.x, i.y], room.polygon) || floor.rooms.some((r) => pointInPolygon([i.x, i.y], r.polygon)))
      break
    }
    case 'add_door':
      findFloor(plan, op.floor).doors.push({ id: newId('door'), a: op.a, b: op.b })
      break
    case 'place': {
      const thing = things.find((t) => t.id === op.ref || t.entityId === op.ref)
      const ref = thing?.id ?? op.ref
      const floor = findFloor(plan, op.floor)
      for (const f of plan.floors) f.items = f.items.filter((i) => i.ref !== ref)
      let at: Point
      if (op.x !== undefined && op.y !== undefined) at = [op.x, op.y]
      else if (op.room) at = spotIn(floor, findRoom(floor, op.room))
      else throw new PlanError('tool.plan.where')
      floor.items.push({ ref, x: Math.round(at[0]), y: Math.round(at[1]) })
      break
    }
    case 'unplace':
      for (const f of plan.floors) f.items = f.items.filter((i) => i.ref !== op.ref)
      break
  }
  plan.updatedAt = Date.now()
  return plan
}

/** Replaces a floor's rooms (from a drawing or a photo), keeping the devices that are still inside some room. */
export function replaceFloorShape(source: HomePlan, floorKey: string | undefined, rooms: PlanRoom[], doors: PlanDoor[], origin: HomePlan['source']): HomePlan {
  const plan = structuredClone(source)
  const floor = findFloor(plan, floorKey)
  // A room that keeps its name keeps its HA area.
  const areaByName = new Map(floor.rooms.map((r) => [fold(r.name), r.areaId]))
  floor.rooms = rooms.map((r) => ({ ...r, areaId: areaByName.get(fold(r.name)) ?? r.areaId }))
  floor.doors = doors
  floor.items = floor.items.filter((i) => floor.rooms.some((r) => pointInPolygon([i.x, i.y], r.polygon)))
  plan.source = origin
  plan.updatedAt = Date.now()
  return plan
}

/**
 * Puts devices that have a room (their HA area is a room of the plan) but no spot yet into that room.
 * Returns the same plan when nothing changed.
 */
export function autoPlace(plan: HomePlan, things: HomeThing[]): HomePlan {
  const placed = new Set(plan.floors.flatMap((f) => f.items.map((i) => i.ref)))
  const todo = things.filter((t) => t.areaId && !placed.has(t.id))
  if (!todo.length) return plan
  const next = structuredClone(plan)
  let changed = false
  for (const thing of todo) {
    for (const floor of next.floors) {
      const room = floor.rooms.find((r) => r.areaId === thing.areaId)
      if (!room) continue
      const at = spotIn(floor, room)
      floor.items.push({ ref: thing.id, x: Math.round(at[0]), y: Math.round(at[1]) })
      changed = true
      break
    }
  }
  return changed ? next : plan
}

/** What the model reads about the plan: rooms with their size and position, and the things in each. */
export function describePlan(plan: HomePlan, things: HomeThing[]): string {
  const byId = new Map(things.map((t) => [t.id, t]))
  const lines: string[] = []
  for (const floor of plan.floors) {
    lines.push(`Floor “${floor.name}” (id ${floor.id}) — units in cm, x to the right, y downward:`)
    if (!floor.rooms.length) lines.push('  (no rooms: the plan has not been drawn yet)')
    for (const room of floor.rooms) {
      const box = bbox(room.polygon)
      const inside = floor.items.filter((i) => roomAt(floor, [i.x, i.y])?.id === room.id)
      lines.push(`  ${room.name}: from (${box.x}, ${box.y}) ${box.w}×${box.h} cm${room.areaId ? ` · HA area ${room.areaId}` : ''}`)
      for (const item of inside) {
        const thing = byId.get(item.ref)
        lines.push(`    · ${thing ? `${thing.name} [${thing.kind}]` : item.ref} at (${item.x}, ${item.y})`)
      }
    }
    const loose = floor.items.filter((i) => !roomAt(floor, [i.x, i.y]))
    for (const item of loose) lines.push(`  outside the rooms: ${byId.get(item.ref)?.name ?? item.ref} at (${item.x}, ${item.y})`)
    if (floor.doors.length) lines.push(`  doors: ${floor.doors.map((d) => `(${d.a}) → (${d.b})`).join('; ')}`)
  }
  const placed = new Set(plan.floors.flatMap((f) => f.items.map((i) => i.ref)))
  const unplaced = things.filter((t) => !placed.has(t.id))
  if (unplaced.length) lines.push(`Not placed on the plan: ${unplaced.map((t) => t.name).join(', ')}`)
  return lines.join('\n')
}
