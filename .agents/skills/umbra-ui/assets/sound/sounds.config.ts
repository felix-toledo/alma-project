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
  /** Path to the audio (e.g. '/sounds/select.ogg'). Empty = silent. */
  src: string
  /** 0..1, multiplied by the global volume */
  volume: number
  /** minimum ms between two plays of the same event */
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
