import type { LucideIcon } from 'lucide-react'
import {
  Accessibility, Bell, Bug, Camera, Gamepad2, HardDrive, Monitor, Network, Power,
  Settings, ShieldCheck, Sparkles, Users, Volume2, Wifi,
} from 'lucide-react'

export const ICON_SIZE = { sm: 20, md: 24, lg: 32 } as const
export const ICON_STROKE = 1.75

/** Envuelve cualquier ícono Lucide con los defaults del sistema (md 24px, stroke 1.75, color heredado). */
export function Icon({ icon: I, size = 'md', className }: { icon: LucideIcon; size?: keyof typeof ICON_SIZE | number; className?: string }) {
  return <I size={typeof size === 'number' ? size : ICON_SIZE[size]} strokeWidth={ICON_STROKE} className={className} aria-hidden="true" />
}

/** Mapa sugerido para pantallas de ajustes. */
export const SETTINGS_ICONS = {
  storage: HardDrive,
  sound: Volume2,
  display: Monitor,
  accessories: Gamepad2,
  notifications: Bell,
  captures: Camera,
  network: Network,
  wifi: Wifi,
  users: Users,
  accessibility: Accessibility,
  privacy: ShieldCheck,
  appearance: Sparkles,
  power: Power,
  debug: Bug,
  general: Settings,
} satisfies Record<string, LucideIcon>

export type SettingsIconKey = keyof typeof SETTINGS_ICONS

/**
 * Botones de control: set propio, trazo simple, sin copiar los símbolos oficiales.
 * Heredan color (currentColor) y tamaño.
 */
const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: ICON_STROKE, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const
type P = { size?: number; className?: string }
export const BtnCross = ({ size = 24, className }: P) => (
  <svg {...base} width={size} height={size} className={className}><path d="M7 7l10 10M17 7L7 17" /></svg>
)
export const BtnRing = ({ size = 24, className }: P) => (
  <svg {...base} width={size} height={size} className={className}><circle cx="12" cy="12" r="6.5" /></svg>
)
export const BtnTriangle = ({ size = 24, className }: P) => (
  <svg {...base} width={size} height={size} className={className}><path d="M12 6.5l6 10.5H6z" /></svg>
)
export const BtnSquare = ({ size = 24, className }: P) => (
  <svg {...base} width={size} height={size} className={className}><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" /></svg>
)
