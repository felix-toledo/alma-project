import { describe, expect, it } from 'vitest'
import {
  confirmView,
  HomeTokens,
  homeRoot,
  isHomeOpenText,
  parseHomeCallback,
  roomView,
  sensitiveActions,
  thingLine,
  toggleControl
} from '../src/coordinator/channels/home-menu'
import type { HomeSnapshot, HomeThing } from '../src/shared/home'
import { translate } from '../src/shared/i18n/messages'

const thing = (over: Partial<HomeThing> = {}): HomeThing => ({
  id: 'device-1',
  name: 'Test light',
  kind: 'light',
  areaId: 'area-1',
  entityId: 'light.test',
  state: 'on',
  on: true,
  available: true,
  attrs: {},
  sensors: [],
  ...over
})

const snapshot = (things: HomeThing[] = [thing()]): HomeSnapshot => ({
  things,
  areas: [
    { id: 'area-1', name: 'Living' },
    { id: 'area-2', name: 'Kitchen' }
  ],
  scenes: [{ entityId: 'scene.night', name: 'Night' }],
  automations: []
})

const callbackBytes = (view: { buttons: { data: string }[][] }): number[] =>
  view.buttons.flat().map((b) => Buffer.byteLength(b.data, 'utf8'))

describe('toggleControl', () => {
  it('toggles lights, switches and fans through their own domain', () => {
    expect(toggleControl(thing({ entityId: 'light.test' }))).toEqual({ service: 'light/toggle', data: {} })
    expect(toggleControl(thing({ kind: 'switch', entityId: 'switch.plug', on: false, state: 'off' }))).toEqual({ service: 'switch/toggle', data: {} })
    expect(toggleControl(thing({ kind: 'fan', entityId: 'fan.ceiling' }))).toEqual({ service: 'fan/toggle', data: {} })
  })

  it('opens or closes plain covers from their current state', () => {
    expect(toggleControl(thing({ kind: 'cover', entityId: 'cover.blind', on: true, state: 'open' }))).toEqual({ service: 'cover/close_cover', data: {} })
    expect(toggleControl(thing({ kind: 'cover', entityId: 'cover.blind', on: false, state: 'closed' }))).toEqual({ service: 'cover/open_cover', data: {} })
  })

  it('pauses a playing speaker and plays any other one', () => {
    expect(toggleControl(thing({ kind: 'speaker', entityId: 'media_player.echo', state: 'playing' }))).toEqual({ service: 'media_player/media_pause', data: {} })
    expect(toggleControl(thing({ kind: 'speaker', entityId: 'media_player.echo', state: 'idle', on: false }))).toEqual({ service: 'media_player/media_play', data: {} })
  })

  it('has no direct action for cameras, climate, sensors, locks and the rest', () => {
    for (const kind of ['camera', 'climate', 'sensor', 'lock', 'alarm', 'other'] as const) {
      expect(toggleControl(thing({ kind, entityId: `${kind}.x` })), kind).toBeNull()
    }
  })
})

describe('sensitiveActions', () => {
  it('is empty for things that need no confirmation', () => {
    expect(sensitiveActions(thing(), 'es')).toEqual([])
    expect(sensitiveActions(thing({ kind: 'cover', entityId: 'cover.blind', deviceClass: undefined }), 'es')).toEqual([])
  })

  it('locks an unlocked lock and unlocks a locked one, reusing the desktop wording', () => {
    const [lock] = sensitiveActions(thing({ kind: 'lock', entityId: 'lock.door', on: true, state: 'unlocked' }), 'es')
    expect(lock.service).toBe('lock/lock')
    expect(lock.label).toBe(translate('es', 'home.lock.lock'))
    expect(lock.confirm).toBe(translate('es', 'home.lock.confirmLock', { name: 'Test light' }))
    const [unlock] = sensitiveActions(thing({ kind: 'lock', entityId: 'lock.door', on: false, state: 'locked' }), 'es')
    expect(unlock.service).toBe('lock/unlock')
    expect(unlock.label).toBe(translate('es', 'home.open'))
  })

  it('offers both arm-away and disarm for an alarm panel, like the desktop does', () => {
    const actions = sensitiveActions(thing({ kind: 'alarm', entityId: 'alarm_control_panel.home', on: false, state: 'disarmed' }), 'es')
    expect(actions.map((a) => a.service)).toEqual(['alarm_control_panel/alarm_arm_away', 'alarm_control_panel/alarm_disarm'])
    expect(actions[0].confirm).toBe(translate('es', 'home.alarm.armConfirm'))
  })

  it('silences a sounding siren and sounds a quiet one', () => {
    const [silence] = sensitiveActions(thing({ kind: 'alarm', entityId: 'siren.yard', on: true, state: 'on' }), 'es')
    expect(silence.service).toBe('siren/turn_off')
    const [sound] = sensitiveActions(thing({ kind: 'alarm', entityId: 'siren.yard', on: false, state: 'off' }), 'es')
    expect(sound.service).toBe('siren/turn_on')
  })

  it('opens or closes garage, gate and door covers with a confirmation naming them', () => {
    const [close] = sensitiveActions(thing({ kind: 'cover', entityId: 'cover.garage', deviceClass: 'garage', on: true, state: 'open' }), 'es')
    expect(close.service).toBe('cover/close_cover')
    expect(close.confirm).toContain('Test light')
    const [open] = sensitiveActions(thing({ kind: 'cover', entityId: 'cover.gate', deviceClass: 'gate', on: false, state: 'closed' }), 'es')
    expect(open.service).toBe('cover/open_cover')
  })
})

describe('HomeTokens', () => {
  it('issues short unique tokens that resolve back and expire on clear', () => {
    const tokens = new HomeTokens()
    const a = tokens.issue({ kind: 'thing', id: 'light.kitchen' })
    const b = tokens.issue({ kind: 'thing', id: 'light.kitchen' })
    expect(a).not.toBe(b)
    expect(a.length).toBeLessThanOrEqual(8)
    expect(tokens.resolve(a)).toEqual({ kind: 'thing', id: 'light.kitchen' })
    expect(tokens.resolve('nope')).toBeUndefined()
    tokens.clear()
    expect(tokens.resolve(a)).toBeUndefined()
  })
})

describe('parseHomeCallback', () => {
  it('parses every home action and rejects anything else', () => {
    expect(parseHomeCallback('hm:home')).toEqual({ action: 'home' })
    expect(parseHomeCallback('hm:room:ab12')).toEqual({ action: 'room', token: 'ab12' })
    expect(parseHomeCallback('hm:toggle:ab12')).toEqual({ action: 'toggle', token: 'ab12' })
    expect(parseHomeCallback('hm:do:ab12:arm')).toEqual({ action: 'do', token: 'ab12', arg: 'arm' })
    expect(parseHomeCallback('hm:do:ab12')).toEqual({ action: 'do', token: 'ab12' })
    for (const bad of ['', 'hm:', 'hm:nope', 'hm:room:', 'ap:1:allow', 'hm:room:a:b:c']) {
      expect(parseHomeCallback(bad), bad).toBeUndefined()
    }
  })
})

describe('homeRoot', () => {
  it('lists rooms with their device counts plus scenes and cameras', () => {
    const view = homeRoot(
      snapshot([
        thing(),
        thing({ id: 'device-2', name: 'Oven', kind: 'switch', areaId: 'area-2', entityId: 'switch.oven', on: false, state: 'off' }),
        thing({ id: 'device-3', name: 'Porch', kind: 'camera', areaId: 'area-2', entityId: 'camera.porch', on: null, state: 'streaming' })
      ]),
      'es',
      new HomeTokens()
    )
    const labels = view.buttons.flat().map((b) => b.label)
    expect(labels.some((l) => l.includes('Living') && l.includes('1'))).toBe(true)
    expect(labels.some((l) => l.includes('Kitchen') && l.includes('2'))).toBe(true)
    expect(labels).toContain(translate('es', 'tg.homeScenes'))
    expect(labels).toContain(translate('es', 'tg.homeCameras'))
    expect(view.text).toContain(translate('es', 'tg.homeTitle'))
  })

  it('shows the roomless things under their own row', () => {
    const view = homeRoot(snapshot([thing({ areaId: null })]), 'es', new HomeTokens())
    expect(view.buttons.flat().map((b) => b.label).some((l) => l.includes(translate('es', 'home.noRoom')))).toBe(true)
  })

  it('says the house is empty when there is nothing to show', () => {
    const view = homeRoot({ things: [], areas: [], scenes: [], automations: [] }, 'es', new HomeTokens())
    expect(view.text).toContain(translate('es', 'tg.homeEmpty'))
    expect(view.buttons.flat()).toEqual([])
  })

  it('keeps every callback payload under the 64-byte Telegram cap', () => {
    const view = homeRoot(
      snapshot([thing({ id: 'a-very-long-device-id-that-home-assistant-could-hand-out', name: 'A very long device name for the living room lamp', entityId: 'light.a_very_long_entity_id_for_the_living_room_lamp' })]),
      'es',
      new HomeTokens()
    )
    expect(callbackBytes(view).every((n) => n <= 64)).toBe(true)
  })
})

describe('roomView', () => {
  it('buttons toggle plain things, ask for sensitive ones and shoot cameras', () => {
    const tokens = new HomeTokens()
    const snap = snapshot([
      thing(),
      thing({ id: 'device-2', name: 'Door', kind: 'lock', areaId: 'area-1', entityId: 'lock.door', on: false, state: 'locked' }),
      thing({ id: 'device-3', name: 'Porch', kind: 'camera', areaId: 'area-1', entityId: 'camera.porch', on: null, state: 'streaming' }),
      thing({ id: 'device-4', name: 'Air', kind: 'climate', areaId: 'area-1', entityId: 'climate.air', on: true, state: 'cool', attrs: { current_temperature: 24 } })
    ])
    const view = roomView(snap, 'area-1', 'es', tokens)
    const byLabel = new Map(view.buttons.flat().map((b) => [b.label, b.data]))
    const dataOf = (name: string): string => [...byLabel.entries()].find(([label]) => label.includes(name))?.[1] ?? ''
    expect(parseHomeCallback(dataOf('Test light'))?.action).toBe('toggle')
    expect(parseHomeCallback(dataOf('Door'))?.action).toBe('ask')
    expect(parseHomeCallback(dataOf('Porch'))?.action).toBe('cam')
    // Climate is shown but has no button: Telegram cannot move a slider.
    expect(dataOf('Air')).toBe('')
    expect(view.text).toContain('Air')
    expect(callbackBytes(view).every((n) => n <= 64)).toBe(true)
  })
})

describe('confirmView', () => {
  it('asks once for a lock and twice (arm/disarm) for an alarm panel', () => {
    const lock = confirmView(thing({ kind: 'lock', entityId: 'lock.door', on: false, state: 'locked' }), 'es', new HomeTokens())
    expect(lock.buttons.flat().filter((b) => parseHomeCallback(b.data)?.action === 'do')).toHaveLength(1)
    expect(lock.text).toContain('Test light')
    const panel = confirmView(thing({ kind: 'alarm', entityId: 'alarm_control_panel.home', on: false, state: 'disarmed' }), 'es', new HomeTokens())
    expect(panel.buttons.flat().filter((b) => parseHomeCallback(b.data)?.action === 'do')).toHaveLength(2)
  })
})

describe('thingLine', () => {
  it('names the thing with its state in one short line', () => {
    expect(thingLine(thing({ attrs: { brightness: 204 } }), 'es')).toContain('80%')
    expect(thingLine(thing({ available: false }), 'es')).toContain(translate('es', 'home.status.offline'))
    expect(thingLine(thing({ kind: 'cover', entityId: 'cover.blind', on: false, state: 'closed' }), 'es')).toContain(translate('es', 'home.status.closed'))
  })
})

describe('isHomeOpenText', () => {
  it('opens on /home and on the Casa button in either language, and on nothing else', () => {
    for (const text of ['/home', '/home@AlmaBot', '/home extra', translate('es', 'tg.homeButton'), translate('en', 'tg.homeButton')]) {
      expect(isHomeOpenText(text, 'es'), text).toBe(true)
    }
    for (const text of ['/homenaje', '/start', '/nuevo', 'home', 'hola']) {
      expect(isHomeOpenText(text, 'es'), text).toBe(false)
    }
  })
})
