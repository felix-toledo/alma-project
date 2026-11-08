import type { FetchLike, FetchResponse } from './session'

/** One thing as the narrow API serves it. */
export interface PwaThing {
  id: string
  entityId: string
  name: string
  kind: string
  areaId: string | null
  state: string
  sensitive: boolean
}

export interface PwaArea {
  id: string
  name: string
}

export type ThingsOutcome =
  | { ok: true; things: PwaThing[]; areas: PwaArea[] }
  | { ok: false; reason: 'refused' | 'scope-off' | 'house-off' | 'network' | 'rate-limited'; note?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isThing(value: unknown): value is PwaThing {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.entityId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.kind === 'string' &&
    (typeof value.areaId === 'string' || value.areaId === null) &&
    typeof value.state === 'string' &&
    typeof value.sensitive === 'boolean'
  )
}

function isArea(value: unknown): value is PwaArea {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
}

function refusalNote(body: unknown): string | undefined {
  if (isRecord(body) && typeof body.note === 'string') return body.note
  return undefined
}

/** Lists the house things with their rooms. */
export async function fetchThings(deps: { fetch: FetchLike; token: string }): Promise<ThingsOutcome> {
  let response: FetchResponse
  try {
    response = await deps.fetch('/api/home/things', { headers: { authorization: `Bearer ${deps.token}` } })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (response.status === 401) return { ok: false, reason: 'refused' }
  if (response.status === 403) return { ok: false, reason: 'scope-off' }
  if (response.status === 429) return { ok: false, reason: 'rate-limited' }
  const body = await response.json().catch(() => null)
  if (response.status === 503) return { ok: false, reason: 'house-off', note: refusalNote(body) }
  if (!response.ok) return { ok: false, reason: 'network' }
  if (!isRecord(body) || !Array.isArray(body.things) || !Array.isArray(body.areas)) return { ok: false, reason: 'network' }
  return { ok: true, things: body.things.filter(isThing), areas: body.areas.filter(isArea) }
}

export interface RoomGroup {
  area: string | null
  things: PwaThing[]
}

/** Groups things by room name; unassigned things go last under no heading. */
export function groupByRoom(things: PwaThing[], areas: PwaArea[]): RoomGroup[] {
  const names = new Map(areas.map((area) => [area.id, area.name]))
  const groups = new Map<string | null, PwaThing[]>()
  for (const thing of things) {
    const area = thing.areaId === null ? null : (names.get(thing.areaId) ?? null)
    const list = groups.get(area) ?? []
    list.push(thing)
    groups.set(area, list)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0))
    .map(([area, roomThings]) => ({ area, things: roomThings }))
}

/** The simple actions the phone offers per kind; locks and alarms add their secure ones. */
export function thingActions(thing: { kind: string; sensitive: boolean }): string[] {
  if (thing.kind === 'light' || thing.kind === 'switch' || thing.kind === 'fan') return ['toggle']
  if (thing.kind === 'lock') return ['lock', 'unlock']
  if (thing.kind === 'cover') return ['open', 'close']
  if (thing.kind === 'alarm') return ['arm_home', 'arm_away', 'disarm']
  return []
}

export type ControlOutcome =
  | { ok: true }
  | { ok: false; reason: 'refused' | 'scope-off' | 'sensitive-off' | 'step-up-required' | 'denied' | 'invalid' | 'network' | 'rate-limited'; note?: string }

/** Runs one action, with a step-up assertion when the dance already ran. */
export async function controlThing(deps: {
  fetch: FetchLike
  token: string
  thing: string
  action: string
  assertion?: { authenticatorData: string; clientDataJSON: string; signature: string }
}): Promise<ControlOutcome> {
  let response: FetchResponse
  try {
    response = await deps.fetch('/api/home/control', {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(deps.assertion ? { thing: deps.thing, action: deps.action, assertion: deps.assertion } : { thing: deps.thing, action: deps.action })
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (response.ok) return { ok: true }
  if (response.status === 401) return { ok: false, reason: 'refused' }
  if (response.status === 429) return { ok: false, reason: 'rate-limited' }
  const body = await response.json().catch(() => null)
  const error = isRecord(body) && typeof body.error === 'string' ? body.error : ''
  if (response.status === 403 && error === 'sensitive-off') return { ok: false, reason: 'sensitive-off' }
  if (response.status === 403 && error === 'step-up-required') return { ok: false, reason: 'step-up-required' }
  if (response.status === 403 && error === 'denied') return { ok: false, reason: 'denied', note: refusalNote(body) }
  if (response.status === 403) return { ok: false, reason: 'scope-off' }
  if (response.status === 400) return { ok: false, reason: 'invalid' }
  return { ok: false, reason: 'network' }
}
