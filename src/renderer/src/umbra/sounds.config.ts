export type UISoundEvent =
  | 'hover'
  | 'focus-move'
  | 'select'
  | 'back'
  | 'toggle-on'
  | 'toggle-off'
  | 'open-modal'
  | 'close-modal'
  | 'error'
  | 'success'
  | 'notification'
  | 'page-transition'

export interface SoundDef {
  /** Ruta al audio (ej. '/sounds/select.ogg'). Vacío = no suena. */
  src: string
  /** 0..1, se multiplica por el volumen global */
  volume: number
  /** ms mínimos entre dos reproducciones del mismo evento */
  cooldown: number
}

export const SOUNDS: Record<UISoundEvent, SoundDef> = {
  hover: { src: '', volume: 0.3, cooldown: 80 },
  'focus-move': { src: '', volume: 0.5, cooldown: 60 },
  select: { src: '', volume: 0.8, cooldown: 0 },
  back: { src: '', volume: 0.7, cooldown: 0 },
  'toggle-on': { src: '', volume: 0.7, cooldown: 0 },
  'toggle-off': { src: '', volume: 0.7, cooldown: 0 },
  'open-modal': { src: '', volume: 0.8, cooldown: 0 },
  'close-modal': { src: '', volume: 0.8, cooldown: 0 },
  error: { src: '', volume: 0.9, cooldown: 200 },
  success: { src: '', volume: 0.9, cooldown: 200 },
  notification: { src: '', volume: 0.8, cooldown: 300 },
  'page-transition': { src: '', volume: 0.6, cooldown: 300 },
}
