import { Activity, Blinds, Camera, CircleHelp, Fan, Lightbulb, Lock, Plug, ShieldAlert, Speaker, Thermometer, type LucideIcon } from 'lucide-react'
import type { DeviceKind, HomeThing } from '../../../shared/home'
import type { T } from '../i18n/useT'
import { request } from '../lib/coordinator'

export const KIND_ICON: Record<DeviceKind, LucideIcon> = {
  light: Lightbulb,
  switch: Plug,
  camera: Camera,
  speaker: Speaker,
  cover: Blinds,
  fan: Fan,
  climate: Thermometer,
  lock: Lock,
  alarm: ShieldAlert,
  sensor: Activity,
  other: CircleHelp
}

export const kindLabel = (kind: DeviceKind, t: T): string => t(`home.kind.${kind}`)

/** Things a tap turns on and off. */
export const TOGGLEABLE: DeviceKind[] = ['light', 'switch', 'fan']

export function statusText(thing: HomeThing, t: T): string {
  if (!thing.available) return t('home.status.offline')
  switch (thing.kind) {
    case 'light':
      return thing.on ? `${t('home.status.lightOn')}${typeof thing.attrs.brightness === 'number' ? ` · ${Math.round((thing.attrs.brightness / 255) * 100)}%` : ''}` : t('home.status.lightOff')
    case 'cover':
      return thing.on ? t('home.status.open') : t('home.status.closed')
    case 'lock':
      return thing.on ? t('home.status.open') : t('home.status.locked')
    case 'camera':
      return t('home.status.camera')
    case 'speaker':
      return thing.state === 'playing' ? `${t('home.status.playing')}${thing.attrs.media_title ? ` «${thing.attrs.media_title}»` : ''}` : thing.on ? t('home.status.on') : t('home.status.off')
    case 'climate':
      return thing.attrs.current_temperature !== undefined ? `${thing.attrs.current_temperature}°` : thing.state
    default:
      return thing.on === null ? thing.state : thing.on ? t('home.status.on') : t('home.status.off')
  }
}

/** The glow colour of a lit light: its own colour when it has one, else warm white from its temperature. */
export function lightColor(thing: HomeThing): string {
  const rgb = thing.attrs.rgb_color as number[] | undefined
  if (Array.isArray(rgb) && rgb.length === 3 && !(rgb[0] > 240 && rgb[1] > 240 && rgb[2] > 240)) return `rgb(${rgb.join(',')})`
  const kelvin = typeof thing.attrs.color_temp_kelvin === 'number' ? thing.attrs.color_temp_kelvin : 2800
  return kelvin >= 5000 ? 'rgb(190,215,255)' : kelvin >= 3800 ? 'rgb(255,236,200)' : 'rgb(255,190,95)'
}

export const brightnessOf = (thing: HomeThing): number => (typeof thing.attrs.brightness === 'number' ? thing.attrs.brightness / 255 : 1)

/** The tap on a thing: lights, plugs and fans toggle; covers open or close. */
export function toggleThing(thing: HomeThing): Promise<unknown> {
  const domain = thing.entityId.split('.')[0]
  if (thing.kind === 'cover') return request({ method: 'home.control', entityId: thing.entityId, service: thing.on ? 'cover/close_cover' : 'cover/open_cover' })
  return request({ method: 'home.control', entityId: thing.entityId, service: `${domain}/toggle` })
}

export const control = (entityId: string, service: string, data?: Record<string, unknown>): Promise<unknown> => request({ method: 'home.control', entityId, service, data })
