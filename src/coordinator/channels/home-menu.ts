// The Casa panel on Telegram: rooms, scenes and cameras as button menus. Pure: it builds texts and buttons from a
// home snapshot, and the channel renders them and runs the actions.
import { isSensitive, type DeviceKind, type HomeSnapshot, type HomeThing } from '../../shared/home'
import { compareText } from '../../shared/i18n/format'
import type { Language } from '../../shared/i18n/language'
import { translate } from '../../shared/i18n/messages'

export interface MenuButton {
  label: string
  data: string
}

export interface MenuView {
  text: string
  buttons: MenuButton[][]
}

export type HomeTarget = { kind: 'area'; id: string | null } | { kind: 'thing'; id: string } | { kind: 'scene'; entityId: string }

/**
 * Short tokens for callback payloads: entity and device ids can be longer than Telegram's 64-byte cap for
 * `callback_data`, so buttons carry a token and the channel resolves it against the live snapshot. Tokens only
 * expire when pruned (old panels then say they expired); the counter never wraps, so a token never points at a
 * different target later.
 */
export class HomeTokens {
  private next = 1
  private targets = new Map<string, HomeTarget>()

  issue(target: HomeTarget): string {
    if (this.targets.size >= 1000) this.targets.delete(this.targets.keys().next().value as string)
    const token = (this.next++).toString(36)
    this.targets.set(token, target)
    return token
  }

  resolve(token: string): HomeTarget | undefined {
    return this.targets.get(token)
  }

  clear(): void {
    this.targets.clear()
  }
}

export interface HomeCallback {
  action: string
  token?: string
  arg?: string
}

const BARE = new Set(['home', 'scenes', 'cams', 'close'])
const WITH_TOKEN = new Set(['room', 'toggle', 'scene', 'cam', 'ask', 'refresh'])

/** Parses a `hm:` callback payload; anything else (approvals included) is not a home callback. */
export function parseHomeCallback(data: string): HomeCallback | undefined {
  if (!data.startsWith('hm:')) return undefined
  const [action, token, arg, extra] = data.slice(3).split(':')
  if (!action || extra !== undefined) return undefined
  if (BARE.has(action)) return token === undefined && arg === undefined ? { action } : undefined
  if (action === 'do') return token ? { action, token, ...(arg ? { arg } : {}) } : undefined
  if (WITH_TOKEN.has(action)) return token && arg === undefined ? { action, token } : undefined
  return undefined
}

/** The Home Assistant service a tap runs on a plain thing; null when a tap does something else (photo, confirm) or nothing. */
export function toggleControl(thing: HomeThing): { service: string; data: Record<string, unknown> } | null {
  const domain = thing.entityId.split('.')[0]
  if (thing.kind === 'light' || thing.kind === 'switch' || thing.kind === 'fan') return { service: `${domain}/toggle`, data: {} }
  if (thing.kind === 'cover' && !isSensitive(thing.kind, thing.deviceClass)) return { service: thing.on ? 'cover/close_cover' : 'cover/open_cover', data: {} }
  if (thing.kind === 'speaker') return { service: thing.state === 'playing' ? 'media_player/media_pause' : 'media_player/media_play', data: {} }
  return null
}

export interface SensitiveAction {
  id: string
  service: string
  label: string
  confirm: string
}

/**
 * What a sensitive thing (lock, alarm, siren, garage/gate/door cover) can do from Telegram. Mirrors the desktop
 * panel: locks toggle with their own wording, alarm panels offer arm-away and disarm, the rest gets a generic
 * confirmation. Empty for things that need no confirmation.
 */
export function sensitiveActions(thing: HomeThing, language: Language): SensitiveAction[] {
  if (!isSensitive(thing.kind, thing.deviceClass)) return []
  if (thing.kind === 'lock') {
    return thing.on
      ? [{ id: 'lock', service: 'lock/lock', label: translate(language, 'home.lock.lock'), confirm: translate(language, 'home.lock.confirmLock', { name: thing.name }) }]
      : [{ id: 'unlock', service: 'lock/unlock', label: translate(language, 'home.open'), confirm: translate(language, 'home.lock.confirmOpen', { name: thing.name }) }]
  }
  if (thing.entityId.startsWith('alarm_control_panel.')) {
    return [
      { id: 'arm', service: 'alarm_control_panel/alarm_arm_away', label: translate(language, 'home.alarm.arm'), confirm: translate(language, 'home.alarm.armConfirm') },
      { id: 'disarm', service: 'alarm_control_panel/alarm_disarm', label: translate(language, 'home.alarm.disarm'), confirm: translate(language, 'home.alarm.disarmConfirm') }
    ]
  }
  if (thing.kind === 'alarm') {
    const label = translate(language, thing.on ? 'home.siren.silence' : 'home.siren.sound')
    return [{ id: thing.on ? 'silence' : 'sound', service: thing.on ? 'siren/turn_off' : 'siren/turn_on', label, confirm: translate(language, 'tg.homeConfirm', { action: label, name: thing.name }) }]
  }
  const open = !thing.on
  const label = translate(language, open ? 'home.open' : 'common.close')
  return [{ id: open ? 'open' : 'close', service: open ? 'cover/open_cover' : 'cover/close_cover', label, confirm: translate(language, 'tg.homeConfirm', { action: label, name: thing.name }) }]
}

const KIND_EMOJI: Record<DeviceKind, string> = {
  light: '💡',
  switch: '🔌',
  camera: '📷',
  speaker: '🔊',
  cover: '🪟',
  fan: '🌀',
  climate: '🌡️',
  lock: '🔒',
  alarm: '🚨',
  sensor: '📊',
  other: '❔'
}

function statusShort(thing: HomeThing, language: Language): string {
  if (!thing.available) return translate(language, 'home.status.offline')
  if (thing.kind === 'light') {
    if (!thing.on) return translate(language, 'home.status.lightOff')
    const pct = typeof thing.attrs.brightness === 'number' ? ` ${Math.round((thing.attrs.brightness / 255) * 100)}%` : ''
    return `${translate(language, 'home.status.lightOn')}${pct}`
  }
  if (thing.kind === 'cover') return translate(language, thing.on ? 'home.status.open' : 'home.status.closed')
  if (thing.kind === 'lock') return translate(language, thing.on ? 'home.status.open' : 'home.status.locked')
  if (thing.kind === 'camera') return translate(language, 'home.status.camera')
  if (thing.kind === 'speaker' && thing.state === 'playing') {
    const title = typeof thing.attrs.media_title === 'string' && thing.attrs.media_title ? ` «${thing.attrs.media_title}»` : ''
    return `${translate(language, 'home.status.playing')}${title}`
  }
  if (thing.kind === 'climate' && thing.attrs.current_temperature !== undefined) return `${thing.attrs.current_temperature}°`
  if (thing.on === null) return thing.state
  return translate(language, thing.on ? 'home.status.on' : 'home.status.off')
}

/** One thing as a line of the panel: its icon, its name and its state. Names come from the house, never from the code. */
export function thingLine(thing: HomeThing, language: Language): string {
  return `${KIND_EMOJI[thing.kind]} ${thing.name} — ${statusShort(thing, language)}`
}

/** Button labels stay short: Telegram truncates long ones and they push the panel off the phone screen. */
function short(text: string, max = 40): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

function closeLabel(language: Language): string {
  return `✕ ${translate(language, 'common.close')}`
}

/** Rooms with their device counts, then scenes and cameras. */
export function homeRoot(snapshot: HomeSnapshot, language: Language, tokens: HomeTokens): MenuView {
  if (!snapshot.things.length && !snapshot.scenes.length) {
    return { text: `${translate(language, 'tg.homeTitle')}\n${translate(language, 'tg.homeEmpty')}`, buttons: [] }
  }
  const counts = new Map<string | null, number>()
  for (const thing of snapshot.things) counts.set(thing.areaId, (counts.get(thing.areaId) ?? 0) + 1)
  const buttons: MenuButton[][] = []
  const compare = compareText(language)
  const areas = [...snapshot.areas].sort((a, b) => compare(a.name, b.name))
  for (const area of areas) {
    const count = counts.get(area.id) ?? 0
    if (!count) continue
    buttons.push([{ label: short(`🛋️ ${area.name} · ${count}`), data: `hm:room:${tokens.issue({ kind: 'area', id: area.id })}` }])
  }
  const roomless = counts.get(null) ?? 0
  if (roomless) buttons.push([{ label: short(`📦 ${translate(language, 'home.noRoom')} · ${roomless}`), data: `hm:room:${tokens.issue({ kind: 'area', id: null })}` }])
  const second: MenuButton[] = []
  if (snapshot.scenes.length) second.push({ label: translate(language, 'tg.homeScenes'), data: 'hm:scenes' })
  if (snapshot.things.some((t) => t.kind === 'camera')) second.push({ label: translate(language, 'tg.homeCameras'), data: 'hm:cams' })
  if (second.length) buttons.push(second)
  buttons.push([
    { label: translate(language, 'tg.homeRefresh'), data: 'hm:home' },
    { label: closeLabel(language), data: 'hm:close' }
  ])
  return { text: `${translate(language, 'tg.homeTitle')}\n${translate(language, 'tg.homeHint')}`, buttons }
}

/** One room: every thing listed, with a button for each thing a tap can do something with. */
export function roomView(snapshot: HomeSnapshot, areaId: string | null, language: Language, tokens: HomeTokens): MenuView {
  const name = areaId ? (snapshot.areas.find((a) => a.id === areaId)?.name ?? translate(language, 'home.noRoom')) : translate(language, 'home.noRoom')
  const things = snapshot.things.filter((t) => t.areaId === areaId)
  const buttons: MenuButton[][] = []
  for (const thing of things) {
    const token = tokens.issue({ kind: 'thing', id: thing.id })
    const label = short(`${KIND_EMOJI[thing.kind]} ${thing.name} · ${statusShort(thing, language)}`)
    if (thing.kind === 'camera') buttons.push([{ label: short(`${KIND_EMOJI.camera} ${thing.name}`), data: `hm:cam:${token}` }])
    else if (sensitiveActions(thing, language).length) buttons.push([{ label, data: `hm:ask:${token}` }])
    else if (toggleControl(thing)) buttons.push([{ label, data: `hm:toggle:${token}` }])
  }
  buttons.push([
    { label: translate(language, 'tg.homeBack'), data: 'hm:home' },
    { label: translate(language, 'tg.homeRefresh'), data: `hm:refresh:${tokens.issue({ kind: 'area', id: areaId })}` },
    { label: closeLabel(language), data: 'hm:close' }
  ])
  return { text: [`🏠 ${name}`, ...things.map((t) => thingLine(t, language))].join('\n'), buttons }
}

export function scenesView(snapshot: HomeSnapshot, language: Language, tokens: HomeTokens): MenuView {
  if (!snapshot.scenes.length) {
    return { text: translate(language, 'tg.homeNoScenes'), buttons: [[{ label: translate(language, 'tg.homeBack'), data: 'hm:home' }]] }
  }
  const buttons = snapshot.scenes.map((scene) => [{ label: short(`🎬 ${scene.name}`), data: `hm:scene:${tokens.issue({ kind: 'scene', entityId: scene.entityId })}` }])
  buttons.push([
    { label: translate(language, 'tg.homeBack'), data: 'hm:home' },
    { label: closeLabel(language), data: 'hm:close' }
  ])
  return { text: translate(language, 'tg.homeScenes'), buttons }
}

export function camerasView(snapshot: HomeSnapshot, language: Language, tokens: HomeTokens): MenuView {
  const cameras = snapshot.things.filter((t) => t.kind === 'camera')
  if (!cameras.length) {
    return { text: translate(language, 'tg.homeNoCameras'), buttons: [[{ label: translate(language, 'tg.homeBack'), data: 'hm:home' }]] }
  }
  const buttons = cameras.map((camera) => [{ label: short(`${KIND_EMOJI.camera} ${camera.name}`), data: `hm:cam:${tokens.issue({ kind: 'thing', id: camera.id })}` }])
  buttons.push([
    { label: translate(language, 'tg.homeBack'), data: 'hm:home' },
    { label: closeLabel(language), data: 'hm:close' }
  ])
  return { text: translate(language, 'tg.homeCameras'), buttons }
}

/** The confirmation a sensitive thing shows before acting; back goes to its room. */
export function confirmView(thing: HomeThing, language: Language, tokens: HomeTokens): MenuView {
  const actions = sensitiveActions(thing, language)
  const buttons = actions.map((action) => [{ label: short(`⚠️ ${action.label}`), data: `hm:do:${tokens.issue({ kind: 'thing', id: thing.id })}:${action.id}` }])
  buttons.push([{ label: translate(language, 'tg.homeBack'), data: `hm:room:${tokens.issue({ kind: 'area', id: thing.areaId })}` }])
  const confirm = actions.length === 1 ? actions[0].confirm : `${thing.name}\n${actions.map((a) => a.confirm).join('\n')}`
  return { text: confirm, buttons }
}

/** True for the texts that open the panel: /home (plain, with the bot name, or with words after it) and the Casa button. */
export function isHomeOpenText(text: string, language: Language): boolean {
  const trimmed = text.trim()
  if (trimmed === '/home' || trimmed.startsWith('/home ') || trimmed.startsWith('/home@')) return true
  const other: Language = language === 'es' ? 'en' : 'es'
  return trimmed === translate(language, 'tg.homeButton') || trimmed === translate(other, 'tg.homeButton')
}
