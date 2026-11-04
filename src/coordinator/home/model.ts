// Turns Home Assistant's registries and states into the things Alma talks about: "la luz de la cocina", "la cámara
// del patio". Pure, so it's tested without a Home Assistant.
import { DEVICE_DOMAINS, type DeviceKind, type HomeArea, type HomeAutomation, type HomeScene, type HomeSensor, type HomeThing } from '../../shared/home'
import type { StateObject } from './ha'

export interface RegArea {
  area_id: string
  name: string
}

export interface RegDevice {
  id: string
  name: string | null
  name_by_user: string | null
  area_id: string | null
  manufacturer: string | null
  model: string | null
  disabled_by: string | null
  config_entries?: string[]
}

export interface RegEntity {
  entity_id: string
  device_id: string | null
  area_id: string | null
  platform: string
  disabled_by: string | null
  hidden_by: string | null
  entity_category: string | null
  config_entry_id?: string | null
  name?: string | null
  original_name?: string | null
}

/** Attributes worth sending to the window and to the agent, per what a thing is. */
const KEEP: Record<DeviceKind, string[]> = {
  light: ['brightness', 'color_mode', 'supported_color_modes', 'rgb_color', 'color_temp_kelvin', 'min_color_temp_kelvin', 'max_color_temp_kelvin', 'effect', 'effect_list'],
  switch: ['device_class', 'current_power_w'],
  camera: ['entity_picture', 'supported_features', 'frontend_stream_type'],
  speaker: ['volume_level', 'is_volume_muted', 'media_title', 'media_artist', 'source', 'source_list'],
  cover: ['current_position', 'device_class'],
  fan: ['percentage', 'preset_mode', 'preset_modes'],
  climate: ['temperature', 'current_temperature', 'hvac_modes', 'hvac_action', 'min_temp', 'max_temp'],
  lock: [],
  alarm: [],
  sensor: [],
  other: []
}

const ON_STATES: Partial<Record<DeviceKind, string[]>> = {
  light: ['on'],
  switch: ['on'],
  fan: ['on'],
  alarm: ['on', 'armed_home', 'armed_away', 'armed_night', 'triggered'],
  cover: ['open', 'opening'],
  speaker: ['playing', 'on'],
  lock: ['unlocked', 'open']
}

const PRIORITY: DeviceKind[] = ['light', 'switch', 'cover', 'fan', 'climate', 'speaker', 'camera', 'lock', 'alarm', 'other']

const domainOf = (entityId: string): string => entityId.slice(0, entityId.indexOf('.'))

function pick(attributes: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) if (attributes[key] !== undefined && attributes[key] !== null) out[key] = attributes[key]
  return out
}

function friendly(state: StateObject | undefined, fallback: string): string {
  const name = state?.attributes.friendly_name
  return typeof name === 'string' && name.trim() ? name : fallback
}

/** A device with exactly one controllable entity IS that entity; one with several (a two-gang switch) shows each. */
export function buildThings(states: Map<string, StateObject>, areas: RegArea[], devices: RegDevice[], entities: RegEntity[]): HomeThing[] {
  void areas
  const deviceById = new Map(devices.map((d) => [d.id, d]))
  // Entities that have a state but no registry entry (YAML ones, demos, anything without a unique id) still count.
  const registered = new Set(entities.map((e) => e.entity_id))
  const unregistered: RegEntity[] = [...states.keys()]
    .filter((id) => !registered.has(id) && domainOf(id) in DEVICE_DOMAINS)
    .map((id) => ({ entity_id: id, device_id: null, area_id: null, platform: 'yaml', disabled_by: null, hidden_by: null, entity_category: null }))
  const usable = [...entities, ...unregistered].filter((e) => !e.disabled_by && !e.hidden_by && !e.entity_category && states.has(e.entity_id))
  const byDevice = new Map<string, RegEntity[]>()
  const loose: RegEntity[] = []
  for (const entity of usable) {
    const device = entity.device_id ? deviceById.get(entity.device_id) : undefined
    if (entity.device_id && !device) continue
    if (device?.disabled_by) continue
    if (!device) loose.push(entity)
    else byDevice.set(device.id, [...(byDevice.get(device.id) ?? []), entity])
  }

  const things: HomeThing[] = []
  const make = (entity: RegEntity, device: RegDevice | undefined, id: string, name: string, sensors: HomeSensor[]): HomeThing => {
    const state = states.get(entity.entity_id)!
    const kind = DEVICE_DOMAINS[domainOf(entity.entity_id)] ?? 'other'
    const attrs = pick(state.attributes, KEEP[kind])
    return {
      id,
      name,
      kind,
      areaId: entity.area_id ?? device?.area_id ?? null,
      entityId: entity.entity_id,
      state: state.state,
      on: ON_STATES[kind] ? ON_STATES[kind]!.includes(state.state) : kind === 'climate' ? state.state !== 'off' : null,
      available: state.state !== 'unavailable',
      attrs,
      sensors,
      integration: entity.platform,
      manufacturer: device?.manufacturer ?? undefined,
      model: device?.model ?? undefined,
      deviceClass: typeof state.attributes.device_class === 'string' ? state.attributes.device_class : undefined
    }
  }

  for (const [deviceId, list] of byDevice) {
    const device = deviceById.get(deviceId)!
    const main = list.filter((e) => domainOf(e.entity_id) in DEVICE_DOMAINS).sort((a, b) => PRIORITY.indexOf(DEVICE_DOMAINS[domainOf(a.entity_id)]) - PRIORITY.indexOf(DEVICE_DOMAINS[domainOf(b.entity_id)]))
    if (!main.length) continue
    const sensors: HomeSensor[] = list
      .filter((e) => ['sensor', 'binary_sensor'].includes(domainOf(e.entity_id)))
      .map((e) => {
        const s = states.get(e.entity_id)!
        return {
          entityId: e.entity_id,
          name: friendly(s, e.entity_id),
          state: s.state,
          unit: typeof s.attributes.unit_of_measurement === 'string' ? s.attributes.unit_of_measurement : undefined,
          deviceClass: typeof s.attributes.device_class === 'string' ? s.attributes.device_class : undefined
        }
      })
    const deviceName = device.name_by_user ?? device.name ?? friendly(states.get(main[0].entity_id), main[0].entity_id)
    main.forEach((entity, index) => {
      const single = main.length === 1
      things.push(make(entity, device, single ? deviceId : entity.entity_id, single ? deviceName : friendly(states.get(entity.entity_id), deviceName), index === 0 ? sensors : []))
    })
  }
  for (const entity of loose) {
    if (!(domainOf(entity.entity_id) in DEVICE_DOMAINS)) continue
    things.push(make(entity, undefined, entity.entity_id, friendly(states.get(entity.entity_id), entity.entity_id), []))
  }
  return things.sort((a, b) => a.name.localeCompare(b.name, 'es'))
}

export const buildAreas = (areas: RegArea[]): HomeArea[] => areas.map((a) => ({ id: a.area_id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name, 'es'))

export function buildScenes(states: Map<string, StateObject>): HomeScene[] {
  return [...states.values()].filter((s) => s.entity_id.startsWith('scene.')).map((s) => ({ entityId: s.entity_id, name: friendly(s, s.entity_id) })).sort((a, b) => a.name.localeCompare(b.name, 'es'))
}

export function buildAutomations(states: Map<string, StateObject>): HomeAutomation[] {
  return [...states.values()]
    .filter((s) => s.entity_id.startsWith('automation.'))
    .map((s) => ({
      id: typeof s.attributes.id === 'string' ? s.attributes.id : s.entity_id.slice('automation.'.length),
      entityId: s.entity_id,
      name: friendly(s, s.entity_id),
      enabled: s.state === 'on',
      lastTriggered: typeof s.attributes.last_triggered === 'string' ? s.attributes.last_triggered : null
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'))
}

/** Lower-case, accent-free, for matching what a person says against names. */
export const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/**
 * Finds things by what the user said: words of the name, the room, or the kind ("la luz de la cocina").
 * Every word must match somewhere; the best matches come first.
 */
export function findThings(things: HomeThing[], areas: HomeArea[], query: string): HomeThing[] {
  const areaName = new Map(areas.map((a) => [a.id, fold(a.name)]))
  const KIND_WORDS: Record<DeviceKind, string[]> = {
    light: ['luz', 'luces', 'foco', 'focos', 'lampara', 'lamparas', 'light', 'led'],
    switch: ['enchufe', 'enchufes', 'interruptor', 'switch', 'rele', 'llave'],
    camera: ['camara', 'camaras', 'cam'],
    speaker: ['parlante', 'parlantes', 'altavoz', 'musica', 'speaker', 'tv', 'television'],
    cover: ['persiana', 'persianas', 'cortina', 'cortinas', 'porton', 'garage'],
    fan: ['ventilador', 'ventiladores'],
    climate: ['aire', 'clima', 'calefaccion', 'termostato'],
    lock: ['cerradura', 'cerraduras', 'puerta'],
    alarm: ['alarma', 'sirena'],
    sensor: ['sensor'],
    other: []
  }
  const filler = new Set(['la', 'el', 'los', 'las', 'de', 'del', 'en', 'un', 'una', 'al', 'mi', 'tu', 'y'])
  const words = fold(query)
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !filler.has(w))
  if (!words.length) return things
  const scored = things
    .map((thing) => {
      const haystack = [fold(thing.name), thing.areaId ? (areaName.get(thing.areaId) ?? '') : '', ...KIND_WORDS[thing.kind]].join(' ')
      const hits = words.filter((w) => haystack.includes(w) || (w.length > 3 && haystack.includes(w.replace(/s$/, ''))))
      return { thing, hits: hits.length }
    })
    .filter((s) => s.hits === words.length)
  return scored.map((s) => s.thing)
}
