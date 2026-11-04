// What an agent can do with the house: see it, control it, add and rename devices, edit the plan, look through
// cameras, and make modes and rules. Everything goes through the same HomeService the window uses.
import * as z from 'zod/v4'
import { formatDateTime } from '../../shared/i18n/format'
import { translate } from '../../shared/i18n/messages'
import { extractJson, isSensitive, planFromVision, type HomeThing } from '../../shared/home'
import { applyPlanOp, describePlan, replaceFloorShape, type PlanOp } from '../home/plan'
import { fold } from '../home/model'
import { cameraQuestion, DEFAULT_CAMERA_QUESTION, DEFAULT_IMAGE_QUESTION, planQuestion } from '../prompts/vision'
import { loadPicture, look } from '../vision'
import { defineTool, languageOf, ToolError, toolText, type ToolContext } from './types'

function home(ctx: ToolContext): NonNullable<ToolContext['home']> {
  if (!ctx.home || !ctx.settings.home.enabled) throw new ToolError('tool.home.off')
  return ctx.home
}

/** Like home(), and also insists the house is connected right now. */
function live(ctx: ToolContext): NonNullable<ToolContext['home']> {
  const service = home(ctx)
  if (!service.hub.ready) {
    const { state, error, step } = service.engine.status()
    throw new ToolError('tool.home.notConnected', { status: `${state}${error ? `: ${error}` : step ? `: ${step}` : ''}` })
  }
  return service
}

const ROOMLESS = 'No room'

function describeThing(thing: HomeThing): string {
  const parts: string[] = []
  if (!thing.available) parts.push('offline')
  else if (thing.kind === 'light') parts.push(thing.on ? `on${typeof thing.attrs.brightness === 'number' ? ` ${Math.round((thing.attrs.brightness / 255) * 100)}%` : ''}` : 'off')
  else if (thing.on !== null) parts.push(thing.kind === 'cover' ? (thing.on ? 'open' : 'closed') : thing.on ? 'on' : 'off')
  else parts.push(thing.state)
  if (thing.kind === 'climate' && thing.attrs.current_temperature !== undefined) parts.push(`${thing.attrs.current_temperature}°`)
  if (thing.kind === 'speaker' && thing.attrs.media_title) parts.push(`playing “${thing.attrs.media_title}”`)
  for (const sensor of thing.sensors.slice(0, 3)) parts.push(`${sensor.name}: ${sensor.state}${sensor.unit ?? ''}`)
  return `${thing.name} [${thing.kind}] ${parts.join(', ')} · id ${thing.entityId}`
}

/** The things a person means by `target`; says what's available when nothing matches. */
function resolve(ctx: ToolContext, target: string, options: { kinds?: HomeThing['kind'][] } = {}): HomeThing[] {
  const { hub } = live(ctx)
  const matches = hub.find(target).filter((t) => !options.kinds || options.kinds.includes(t.kind))
  if (!matches.length) {
    const all = hub.snapshot().things.filter((t) => !options.kinds || options.kinds.includes(t.kind))
    throw all.length ? new ToolError('tool.home.notFound', { target, names: all.map((t) => t.name).join(', ') }) : new ToolError('tool.home.notFoundNone', { target })
  }
  return matches
}

function exactlyOne(things: HomeThing[], target: string, all?: boolean): HomeThing[] {
  if (things.length > 1 && !all) {
    throw new ToolError('tool.home.several', { target, count: things.length, names: things.map((t) => `${t.name} (${t.entityId})`).join(', ') })
  }
  return things
}

const COLORS: Record<string, [number, number, number]> = {
  rojo: [255, 0, 0],
  verde: [0, 200, 0],
  azul: [0, 70, 255],
  amarillo: [255, 220, 0],
  naranja: [255, 120, 0],
  violeta: [150, 0, 255],
  morado: [150, 0, 255],
  rosa: [255, 90, 170],
  celeste: [80, 200, 255],
  blanco: [255, 255, 255]
}
const TEMPERATURES: Record<string, number> = { calida: 2700, calido: 2700, neutra: 4000, neutro: 4000, fria: 6000, frio: 6000 }

const ControlInput = z.object({
  target: z.string().describe('Name, room or type ("kitchen light", "all the living room lights") or the exact id of the device'),
  action: z.enum(['on', 'off', 'toggle', 'set', 'open', 'close', 'play', 'pause', 'stop', 'next', 'previous']).describe('set = adjust values without changing on/off (brightness, volume, position, temperature)'),
  brightness: z.number().min(0).max(100).optional().describe('Lights: brightness in %'),
  color: z.string().optional().describe('Lights: name (rojo, azul, celeste…)'),
  rgb: z.tuple([z.number(), z.number(), z.number()]).optional().describe('Lights: color [r,g,b]'),
  temperature: z.union([z.string(), z.number()]).optional().describe('Lights: "calida", "neutra", "fria" or kelvin'),
  position: z.number().min(0).max(100).optional().describe('Blinds: % open'),
  volume: z.number().min(0).max(100).optional().describe('Speakers: volume %'),
  percentage: z.number().min(0).max(100).optional().describe('Fans: speed %'),
  setpoint: z.number().optional().describe('Air conditioning/heating: target temperature'),
  all: z.boolean().optional().describe('true to act on all that match')
})

type ControlCall = { service: string; data: Record<string, unknown> }

/** The HA service for an action on a thing; null when that thing can't do it. */
function serviceFor(thing: HomeThing, input: z.infer<typeof ControlInput>): ControlCall[] {
  const domain = thing.entityId.split('.')[0]
  const calls: ControlCall[] = []
  const light: Record<string, unknown> = {}
  if (input.brightness !== undefined) light.brightness_pct = input.brightness
  if (input.rgb) light.rgb_color = input.rgb
  else if (input.color) {
    const rgb = COLORS[fold(input.color)]
    if (!rgb) throw new ToolError('tool.home.badColor', { color: input.color, names: Object.keys(COLORS).join(', ') })
    light.rgb_color = rgb
  }
  if (input.temperature !== undefined) light.color_temp_kelvin = typeof input.temperature === 'number' ? input.temperature : (TEMPERATURES[fold(input.temperature)] ?? Number(input.temperature))
  switch (input.action) {
    case 'on':
    case 'set':
    case 'toggle':
    case 'off':
    case 'open':
    case 'close': {
      if (domain === 'cover') {
        if (input.position !== undefined) calls.push({ service: 'cover/set_cover_position', data: { position: input.position } })
        else calls.push({ service: input.action === 'off' || input.action === 'close' ? 'cover/close_cover' : input.action === 'toggle' ? 'cover/toggle' : 'cover/open_cover', data: {} })
        break
      }
      if (input.action === 'toggle') calls.push({ service: `${domain}/toggle`, data: {} })
      else if (input.action === 'off' || input.action === 'close') calls.push({ service: `${domain}/turn_off`, data: {} })
      else if (domain === 'light') calls.push({ service: 'light/turn_on', data: light })
      else if (domain === 'fan' && input.percentage !== undefined) calls.push({ service: 'fan/set_percentage', data: { percentage: input.percentage } })
      else if (domain === 'climate' && input.setpoint !== undefined) calls.push({ service: 'climate/set_temperature', data: { temperature: input.setpoint } })
      else if (input.action !== 'set') calls.push({ service: `${domain}/turn_on`, data: {} })
      if (domain === 'media_player' && input.volume !== undefined) calls.push({ service: 'media_player/volume_set', data: { volume_level: input.volume / 100 } })
      if (domain === 'light' && input.action === 'set' && !calls.length) calls.push({ service: 'light/turn_on', data: light })
      break
    }
    case 'play':
    case 'pause':
    case 'stop':
    case 'next':
    case 'previous': {
      if (domain !== 'media_player') throw new ToolError('tool.home.notPlayer', { name: thing.name })
      const names = { play: 'media_play', pause: 'media_pause', stop: 'media_stop', next: 'media_next_track', previous: 'media_previous_track' } as const
      calls.push({ service: `media_player/${names[input.action]}`, data: {} })
      break
    }
  }
  if (domain === 'media_player' && input.volume !== undefined && !calls.some((c) => c.service.endsWith('volume_set'))) calls.push({ service: 'media_player/volume_set', data: { volume_level: input.volume / 100 } })
  if (!calls.length) throw new ToolError('tool.home.noAction', { action: input.action, name: thing.name, kind: thing.kind })
  return calls
}

export const homeOverviewTool = defineTool({
  name: 'home_overview',
  description: 'Shows the house: rooms, devices with their current state, modes (scenes) and rules. Use it to know what there is before acting or to answer “which lights are on?”.',
  risk: 'read',
  standalone: true,
  schema: z.object({ room: z.string().optional().describe('Only this room') }),
  async run({ room }, ctx) {
    const service = home(ctx)
    if (!service.hub.ready) {
      const { state, error, step } = service.engine.status()
      return toolText(ctx, 'tool.home.notConnectedYet', { status: `${state}${error ? `: ${error}` : step ? `: ${step}` : ''}` })
    }
    const snapshot = service.hub.snapshot()
    const areaName = new Map(snapshot.areas.map((a) => [a.id, a.name]))
    const groups = new Map<string, HomeThing[]>()
    for (const thing of snapshot.things) {
      const name = thing.areaId ? (areaName.get(thing.areaId) ?? ROOMLESS) : ROOMLESS
      if (room && fold(name) !== fold(room) && !fold(name).includes(fold(room))) continue
      groups.set(name, [...(groups.get(name) ?? []), thing])
    }
    const lines = [...groups.entries()].map(([name, things]) => `${name} (${things.length}):\n${things.map((t) => `  - ${describeThing(t)}`).join('\n')}`)
    const rules = service.rulesView()
    return [
      lines.join('\n') || 'There are no devices yet. They are added with home_add_device or from Home → Add device.',
      snapshot.scenes.length ? `Modes: ${snapshot.scenes.map((s) => s.name).join(', ')}` : '',
      `Rules: ${rules.automations.length} automatic, ${rules.judgment.length} with Alma's judgment, ${rules.watches.length} camera watches.`
    ]
      .filter(Boolean)
      .join('\n')
  }
})

export const homeFindTool = defineTool({
  name: 'home_find',
  description: 'Searches for devices by words (“kitchen light”, “cameras”, “living room speaker”) and returns which they are, with their id.',
  risk: 'read',
  standalone: true,
  schema: z.object({ query: z.string() }),
  async run({ query }, ctx) {
    return resolve(ctx, query).map(describeThing).join('\n')
  }
})

export const homeControlTool = defineTool({
  name: 'home_control',
  description:
    'Turns on, turns off or adjusts lights, plugs, switches, fans, blinds, air conditioning and speakers. It happens right away, without asking. It does NOT work for locks, alarms or gates (use home_secure_control). If `target` matches several devices, clarify or pass all: true.',
  risk: 'home',
  standalone: true,
  schema: ControlInput,
  async run(input, ctx) {
    const service = live(ctx)
    const things = exactlyOne(resolve(ctx, input.target), input.target, input.all)
    const blocked = things.filter((t) => isSensitive(t.kind, t.deviceClass))
    if (blocked.length) throw new ToolError('tool.home.sensitive', { names: blocked.map((t) => t.name).join(', ') })
    for (const thing of things) {
      for (const call of serviceFor(thing, input)) await service.hub.control(thing.entityId, call.service, call.data)
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
    return things.map((t) => describeThing(service.hub.thing(t.id) ?? t)).join('\n')
  }
})

export const homeSecureControlTool = defineTool({
  name: 'home_secure_control',
  description: 'Handles locks, alarms, sirens and gates/garages. It always asks the user for approval.',
  risk: 'publish',
  standalone: true,
  schema: z.object({
    target: z.string(),
    action: z.enum(['lock', 'unlock', 'open', 'close', 'arm_home', 'arm_away', 'disarm', 'trigger'])
  }),
  async run({ target, action }, ctx) {
    const service = live(ctx)
    const things = resolve(ctx, target).filter((t) => isSensitive(t.kind, t.deviceClass))
    if (!things.length) throw new ToolError('tool.home.notSecure', { target })
    if (things.length > 1) throw new ToolError('tool.home.severalSecure', { target, names: things.map((t) => `${t.name} (${t.entityId})`).join(', ') })
    const [thing] = things
    const domain = thing.entityId.split('.')[0]
    const map: Record<string, string> = {
      lock: `${domain}/lock`,
      unlock: `${domain}/unlock`,
      open: domain === 'cover' ? 'cover/open_cover' : `${domain}/open`,
      close: domain === 'cover' ? 'cover/close_cover' : `${domain}/close`,
      arm_home: 'alarm_control_panel/alarm_arm_home',
      arm_away: 'alarm_control_panel/alarm_arm_away',
      disarm: 'alarm_control_panel/alarm_disarm',
      trigger: 'siren/turn_on'
    }
    await service.hub.control(thing.entityId, map[action])
    await new Promise((resolve) => setTimeout(resolve, 900))
    return describeThing(service.hub.thing(thing.id) ?? thing)
  },
  async preview({ target, action }) {
    return { note: `${action} → ${target}` }
  }
})

export const homeCallServiceTool = defineTool({
  name: 'home_call_service',
  description:
    'Calls any Home Assistant service (the back door for everything the other tools do not cover). E.g.: domain "light", service "turn_on", entity_id "light.cocina", data {"effect":"rainbow"}. For locks, alarms and gates it asks for approval just like home_secure_control.',
  risk: 'write',
  standalone: true,
  schema: z.object({ domain: z.string(), service: z.string(), entity_id: z.union([z.string(), z.array(z.string())]).optional(), data: z.record(z.string(), z.unknown()).optional() }),
  async run({ domain, service, entity_id, data }, ctx) {
    const { hub } = live(ctx)
    if (['lock', 'alarm_control_panel', 'siren'].includes(domain)) throw new ToolError('tool.home.sensitiveService')
    await hub.callService(domain, service, data ?? {}, entity_id)
    return entity_id ? toolText(ctx, 'tool.home.doneOn', { domain, service, entities: [entity_id].flat().join(', ') }) : toolText(ctx, 'tool.home.done', { domain, service })
  }
})

const AddInput = z.object({
  brand: z.string().optional().describe('Brand or integration to add: “tuya”, “sonoff” (eWeLink), “onvif”, “tplink” (Tapo and Kasa), “hue”… It can also be searched by name. Only for the first step.'),
  flow_id: z.string().optional().describe('The flow_id the previous step returned, to continue'),
  data: z.record(z.string(), z.unknown()).optional().describe('The data the step asks for (the field names in the list)'),
  menu: z.string().optional().describe('If the step is a menu: the chosen option')
})

function describeStep(step: Awaited<ReturnType<NonNullable<ToolContext['home']>['hub']['startFlow']>>): string {
  const lines = [`[flow_id ${step.flowId}] ${step.title}`]
  if (step.description) lines.push(step.description)
  switch (step.kind) {
    case 'form':
      lines.push(...Object.entries(step.errors).map(([field, error]) => `ERROR${field ? ` in ${field}` : ''}: ${error}`))
      if (step.qr) lines.push('There is a QR code to scan with the manufacturer\'s app: it is already open in the Home window. Ask the user to scan it and confirm, then call again with this flow_id and data {} .')
      if (step.fields.length) lines.push('Fields:', ...step.fields.map((f) => `- ${f.name} (${f.type}${f.required ? ', required' : ''})${f.label ? `: ${f.label}` : ''}${f.hint ? ` — ${f.hint}` : ''}${f.options ? ` · options: ${f.options.map((o) => `${o.value}=${o.label}`).join(' | ')}` : ''}${f.default !== undefined && f.default !== '' ? ` · default ${JSON.stringify(f.default)}` : ''}`))
      else if (!step.qr) lines.push('(No fields: call again with this flow_id and data {} to continue.)')
      break
    case 'menu':
      lines.push('Options (pass them in `menu`):', ...(step.menu ?? []).map((m) => `- ${m.id}: ${m.label}`))
      break
    case 'external':
      lines.push(`The user has to open ${step.url} and complete the step; then call again with this flow_id (no data).`)
      break
    case 'done':
      lines.push('✔ Added. The new devices show up in home_overview (it can take a few seconds). Ask the user which room each one goes in and use home_edit_device.')
      break
    case 'abort':
      lines.push(`✘ ${step.reason ?? 'It could not be done.'}`)
      break
  }
  return lines.join('\n')
}

export const homeAddDeviceTool = defineTool({
  name: 'home_add_device',
  description:
    'Adds a device or a brand account (Tuya/Smart Life, eWeLink/Sonoff, Tapo/ONVIF cameras, Hue…) following the Home Assistant steps. First call: only `brand`. Each answer says what data it asks for; ask the user for it (they type the passwords and codes themselves) and keep calling with flow_id + data until it says “Added”. If it asks to scan a QR, the QR is shown in the Home window.',
  risk: 'write',
  standalone: true,
  schema: AddInput,
  async run(input, ctx) {
    const service = live(ctx)
    let step: Awaited<ReturnType<typeof service.hub.stepFlow>>
    if (input.flow_id) step = await service.hub.stepFlow(input.flow_id, input.menu !== undefined ? undefined : input.data, input.menu, languageOf(ctx))
    else {
      if (!input.brand) throw new ToolError('tool.home.needBrand')
      const wanted = fold(input.brand)
      const all = await service.hub.integrations()
      const exact = all.find((i) => i.domain === wanted) ?? all.find((i) => fold(i.name) === wanted)
      const candidates = exact ? [exact] : all.filter((i) => fold(i.name).includes(wanted) || i.domain.includes(wanted))
      if (candidates.length !== 1) {
        throw candidates.length ? new ToolError('tool.home.brandSeveral', { brand: input.brand, names: candidates.slice(0, 12).map((i) => `${i.name} (${i.domain})`).join(', ') }) : new ToolError('tool.home.brandUnknown', { brand: input.brand })
      }
      step = await service.hub.startFlow(candidates[0].domain, languageOf(ctx))
    }
    if (step.qr || step.kind === 'external') ctx.home!.showFlow(step)
    return describeStep(step)
  }
})

export const homeEditDeviceTool = defineTool({
  name: 'home_edit_device',
  description: 'Renames a device or moves it to another room (the room is created if it does not exist).',
  risk: 'write',
  standalone: true,
  schema: z.object({ target: z.string(), name: z.string().optional().describe('New name'), room: z.string().optional().describe('Room; empty “” to leave it without a room') }),
  async run({ target, name, room }, ctx) {
    const service = live(ctx)
    const [thing] = exactlyOne(resolve(ctx, target), target)
    const areaId = room === undefined ? undefined : room.trim() ? await service.hub.ensureArea(room) : null
    await service.hub.updateThing(thing.id, { ...(name !== undefined ? { name } : {}), ...(areaId !== undefined ? { areaId } : {}) })
    if (room === undefined) return toolText(ctx, 'tool.home.edited', { name: name ?? thing.name })
    return room ? toolText(ctx, 'tool.home.editedRoom', { name: name ?? thing.name, room }) : toolText(ctx, 'tool.home.editedNoRoom', { name: name ?? thing.name })
  }
})

export const homeRemoveDeviceTool = defineTool({
  name: 'home_remove_device',
  description: 'Removes a device from the house (if its integration does not allow it, it hides it). To remove a whole account (all the devices of a brand) the user does it from Home.',
  risk: 'write',
  standalone: true,
  schema: z.object({ target: z.string() }),
  async run({ target }, ctx) {
    const service = live(ctx)
    const [thing] = exactlyOne(resolve(ctx, target), target)
    return toolText(ctx, 'tool.home.removed', { name: thing.name, data: await service.hub.removeThing(thing.id) })
  }
})

export const homePlanTool = defineTool({
  name: 'home_plan',
  description: 'Shows the plan of the house: floors, rooms (position and size in cm) and where each device is. It helps to understand “the light next to the door” or “the ones upstairs”.',
  risk: 'read',
  standalone: true,
  schema: z.object({}),
  async run(_input, ctx) {
    const service = home(ctx)
    return describePlan(service.plan.get(), service.hub.ready ? service.hub.snapshot().things : [])
  }
})

const Point = z.tuple([z.number(), z.number()])
const Rect = z.tuple([z.number(), z.number(), z.number(), z.number()]).describe('[x, y, width, height] in cm')
const PlanOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_floor'), name: z.string() }),
  z.object({ op: z.literal('rename_floor'), floor: z.string(), name: z.string() }),
  z.object({ op: z.literal('remove_floor'), floor: z.string() }),
  z.object({ op: z.literal('add_room'), floor: z.string().optional(), name: z.string(), rect: Rect.optional(), polygon: z.array(Point).optional() }),
  z.object({ op: z.literal('rename_room'), floor: z.string().optional(), room: z.string(), name: z.string() }),
  z.object({ op: z.literal('set_room_shape'), floor: z.string().optional(), room: z.string(), rect: Rect.optional(), polygon: z.array(Point).optional() }),
  z.object({ op: z.literal('remove_room'), floor: z.string().optional(), room: z.string() }),
  z.object({ op: z.literal('add_door'), floor: z.string().optional(), a: Point, b: Point }),
  z.object({ op: z.literal('place'), floor: z.string().optional(), ref: z.string().describe('id or name of the device'), room: z.string().optional(), x: z.number().optional(), y: z.number().optional() }),
  z.object({ op: z.literal('unplace'), ref: z.string() })
])

export const homePlanEditTool = defineTool({
  name: 'home_plan_edit',
  description:
    'Edits the plan of the house: floors, rooms (rectangles or polygons in cm), doors and the location of the devices. Several operations per call, in order. A new room creates its area in Home Assistant; placing a device in a room moves it to that room.',
  risk: 'home',
  standalone: true,
  schema: z.object({ ops: z.array(PlanOpSchema).min(1) }),
  async run({ ops }, ctx) {
    const service = home(ctx)
    const things = service.hub.ready ? service.hub.snapshot().things : []
    let plan = service.plan.get()
    for (const op of ops) {
      // The agent may name a device instead of giving its id.
      if (op.op === 'place' || op.op === 'unplace') {
        const thing = things.find((t) => t.id === op.ref || t.entityId === op.ref) ?? resolve(ctx, op.ref)[0]
        op.ref = thing.id
      }
      plan = applyPlanOp(plan, op as PlanOp, things, languageOf(ctx))
    }
    plan = await service.savePlan(plan)
    return describePlan(plan, things)
  }
})

export const homePlanFromDrawingTool = defineTool({
  name: 'home_plan_from_drawing',
  description: 'Builds the rooms of the plan from an Excalidraw drawing in the vault: each rectangle is a room and the text inside is its name. It replaces the rooms of the floor.',
  risk: 'home',
  standalone: true,
  schema: z.object({ path: z.string().describe('Path of the .excalidraw in the vault'), floor: z.string().optional() }),
  async run({ path, floor }, ctx) {
    const service = home(ctx)
    try {
      const plan = await service.planFromDrawing(path, floor ? (service.plan.get().floors.find((f) => fold(f.name) === fold(floor))?.id ?? floor) : undefined)
      return describePlan(plan, service.hub.ready ? service.hub.snapshot().things : [])
    } catch (error) {
      throw error
    }
  }
})

export function pictureRoots(ctx: ToolContext): string[] {
  return [ctx.inboxDir, ctx.knowledge?.root, ctx.workspace].filter((p): p is string => !!p)
}

export const homePlanFromImageTool = defineTool({
  name: 'home_plan_from_image',
  description: 'Builds the rooms of the plan by looking at an image: a plan, a sketch or a photo of the house seen from above. It replaces the rooms of the floor; the user can adjust them afterwards in Home.',
  risk: 'home',
  standalone: true,
  schema: z.object({ path: z.string().describe('Path of the image (the one the user sent you)'), hint: z.string().optional().describe('Facts from the user: room names, measurements, how many floors…'), floor: z.string().optional() }),
  async run({ path, hint, floor }, ctx) {
    const service = home(ctx)
    const picture = loadPicture(path, pictureRoots(ctx))
    const answer = await look(ctx.settings, [picture], planQuestion(hint ?? ''), ctx.signal)
    let plan: ReturnType<typeof replaceFloorShape>
    try {
      const { rooms, doors } = planFromVision(extractJson(answer.text), picture.width && picture.height ? picture.width / picture.height : 1, languageOf(ctx))
      const floors = service.plan.get().floors
      plan = replaceFloorShape(service.plan.get(), floor ? (floors.find((f) => fold(f.name) === fold(floor))?.id ?? floor) : undefined, rooms, doors, { kind: 'photo', ref: path })
    } catch (error) {
      throw new ToolError('tool.home.planFailed', { error: (error as Error).message })
    }
    const saved = await service.savePlan(plan)
    return toolText(ctx, 'tool.home.planShown', { data: describePlan(saved, service.hub.ready ? service.hub.snapshot().things : []) })
  }
})

export const lookAtImageTool = defineTool({
  name: 'look_at_image',
  description: 'Looks at an image (a photo the user sent, a screenshot, an image in the vault) and answers a question about it. For photos of rooms: which room it looks like, which devices can be seen (lamps, TV, speakers).',
  risk: 'read',
  standalone: true,
  schema: z.object({ path: z.string(), question: z.string().default(DEFAULT_IMAGE_QUESTION) }),
  async run({ path, question }, ctx) {
    return (await look(ctx.settings, [loadPicture(path, pictureRoots(ctx))], question, ctx.signal)).text
  }
})

export const cameraLookTool = defineTool({
  name: 'camera_look',
  description: 'Takes a photo from a camera of the house now and answers what can be seen (or the question you ask). With send_telegram it sends the photo to the user\'s phone.',
  risk: 'write',
  standalone: true,
  schema: z.object({ camera: z.string().describe('Name or room of the camera'), question: z.string().default(DEFAULT_CAMERA_QUESTION), send_telegram: z.boolean().optional() }),
  async run({ camera, question, send_telegram }, ctx) {
    const service = live(ctx)
    const [thing] = exactlyOne(resolve(ctx, camera, { kinds: ['camera'] }), camera)
    const jpeg = await service.hub.cameraSnapshot(thing.entityId)
    service.saveStill(thing.entityId, jpeg)
    // The picture matters more than its description: if the vision model fails (no credit, no key), the photo still goes out.
    let text: string
    let failure = ''
    try {
      text = (await look(ctx.settings, [{ mediaType: 'image/jpeg', data: jpeg.toString('base64') }], cameraQuestion(thing.name, question), ctx.signal)).text
    } catch (error) {
      failure = (error as Error).message
      text = translate(languageOf(ctx), 'tool.home.noAnalysis')
    }
    let sent = ''
    if (send_telegram) sent = (await ctx.sendTelegramPhoto?.(jpeg, `${thing.name}: ${text}`.slice(0, 1000))) ? '\n(Photo sent by Telegram.)' : '\n(I could not send the photo by Telegram: it is not connected.)'
    return failure ? `${thing.name}: I could not analyze the image (${failure}).${sent}` : `${thing.name}: ${text}${sent}`
  }
})

export const cameraPhotoTool = defineTool({
  name: 'camera_photo',
  description:
    'Takes a photo from a camera of the house and SENDS it to the user by Telegram, without analyzing it (it spends no vision). Use it when they ask “send me a photo / a snapshot of the camera”. If they also want to know what can be seen, use camera_look.',
  risk: 'write',
  standalone: true,
  schema: z.object({ camera: z.string().describe('Name or room of the camera') }),
  async run({ camera }, ctx) {
    const service = live(ctx)
    const [thing] = exactlyOne(resolve(ctx, camera, { kinds: ['camera'] }), camera)
    const jpeg = await service.hub.cameraSnapshot(thing.entityId)
    const file = service.saveStill(thing.entityId, jpeg)
    const sent = await ctx.sendTelegramPhoto?.(jpeg, thing.name).catch((error: Error) => {
      throw new ToolError('tool.home.telegramRejected', { error: error.message })
    })
    return sent ? toolText(ctx, 'tool.home.photoSent', { name: thing.name }) : toolText(ctx, 'tool.home.photoNotSent', { name: thing.name, file })
  }
})

export const cameraWatchTool = defineTool({
  name: 'camera_watch',
  description:
    'Watches a camera for a limited time: every so often it looks at the image and notifies the user (notification and Telegram, with a photo) when what they asked for is met. Each look spends vision tokens, so use reasonable intervals (30–120 s) and bounded times. action: start / stop / list.',
  risk: 'write',
  standalone: true,
  schema: z.object({
    action: z.enum(['start', 'stop', 'list']),
    camera: z.string().optional(),
    condition: z.string().optional().describe('What to look for: “a package arrives at the door”, “a person appears”'),
    minutes: z.number().min(1).max(360).default(60),
    every_seconds: z.number().min(10).max(900).default(60),
    repeat: z.boolean().default(false).describe('Keep watching after notifying'),
    id: z.string().optional().describe('stop: id of the watch')
  }),
  async run(input, ctx) {
    const service = live(ctx)
    if (input.action === 'list') {
      const watches = service.triggers.rules().watches
      return watches.length ? watches.map((w) => `${w.id}: ${w.cameraName} — “${w.condition}” every ${w.everySec}s, ${w.checks} looks, until ${formatDateTime('en', w.until, 'time')}${w.lastNote ? ` · last: ${w.lastNote}` : ''}`).join('\n') : toolText(ctx, 'tool.home.noWatches')
    }
    if (input.action === 'stop') {
      const watches = service.triggers.rules().watches
      const target = input.id ?? (watches.length === 1 ? watches[0].id : undefined)
      if (!target) throw watches.length ? new ToolError('tool.home.watchWhich', { names: watches.map((w) => `${w.id} (${w.cameraName})`).join(', ') }) : new ToolError('tool.home.watchWhichNone')
      return service.triggers.stopWatch(target) ? toolText(ctx, 'tool.home.watchStopped') : toolText(ctx, 'tool.home.watchMissing')
    }
    if (!input.camera || !input.condition) throw new ToolError('tool.home.watchNeeds')
    const [thing] = exactlyOne(resolve(ctx, input.camera, { kinds: ['camera'] }), input.camera)
    const watch = service.triggers.startWatch({ entityId: thing.entityId, cameraName: thing.name, condition: input.condition, everySec: input.every_seconds, minutes: input.minutes, repeat: input.repeat })
    const looks = Math.ceil((input.minutes * 60) / watch.everySec)
    return toolText(ctx, 'tool.home.watchStarted', { name: thing.name, id: watch.id, condition: input.condition, every: watch.everySec, minutes: input.minutes, looks })
  }
})

export const homeSceneTool = defineTool({
  name: 'home_scene',
  description: 'Activates a mode (scene) of the house by its name: “Night”, “Cinema”, “I left”. The available modes are in home_overview.',
  risk: 'home',
  standalone: true,
  schema: z.object({ name: z.string() }),
  async run({ name }, ctx) {
    const { hub } = live(ctx)
    const scenes = hub.scenes()
    const wanted = fold(name)
    const scene = scenes.find((s) => fold(s.name) === wanted || s.entityId === name) ?? scenes.filter((s) => fold(s.name).includes(wanted))[0]
    if (!scene) throw scenes.length ? new ToolError('tool.home.noMode', { name, names: scenes.map((s) => s.name).join(', ') }) : new ToolError('tool.home.noModeNone', { name })
    await hub.callService('scene', 'turn_on', {}, scene.entityId)
    return toolText(ctx, 'tool.home.modeOn', { name: scene.name })
  }
})

export const homeModesTool = defineTool({
  name: 'home_modes',
  description:
    'Creates, shows or deletes modes (scenes). To create: `devices` with what each device should do ({"luz cocina": {"state":"on","brightness_pct":30}, "luz pasillo": {"state":"off"}}), or `from_current` with the devices whose current state is saved as it is.',
  risk: 'write',
  standalone: true,
  schema: z.object({
    action: z.enum(['create', 'show', 'delete', 'list']),
    name: z.string().optional(),
    devices: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    from_current: z.array(z.string()).optional()
  }),
  async run({ action, name, devices, from_current }, ctx) {
    const { hub } = live(ctx)
    if (action === 'list') return hub.scenes().map((s) => s.name).join(', ') || toolText(ctx, 'tool.home.noScenes')
    if (!name) throw new ToolError('tool.home.modeName')
    const scene = hub.scenes().find((s) => fold(s.name) === fold(name))
    if (action === 'show') return scene ? JSON.stringify(await hub.sceneConfig(scene.entityId), null, 2) : toolText(ctx, 'tool.home.noScene', { name })
    if (action === 'delete') {
      if (!scene) throw new ToolError('tool.home.noScene', { name })
      await hub.deleteScene(scene.entityId)
      return toolText(ctx, 'tool.home.modeDeleted', { name })
    }
    const entities: Record<string, Record<string, unknown>> = {}
    for (const [target, wanted] of Object.entries(devices ?? {})) {
      for (const thing of exactlyOne(resolve(ctx, target), target, true)) entities[thing.entityId] = wanted
    }
    for (const target of from_current ?? []) {
      for (const thing of resolve(ctx, target)) {
        const raw = hub.state(thing.entityId)
        if (!raw) continue
        const keep: Record<string, unknown> = { state: raw.state }
        for (const key of ['brightness', 'rgb_color', 'color_temp_kelvin', 'current_position', 'percentage', 'temperature', 'volume_level']) if (raw.attributes[key] != null) keep[key] = raw.attributes[key]
        entities[thing.entityId] = keep
      }
    }
    if (!Object.keys(entities).length) throw new ToolError('tool.home.modeNeeds')
    await hub.saveScene(name, entities, scene ? String(hub.state(scene.entityId)?.attributes.id ?? '') || undefined : undefined)
    return toolText(ctx, 'tool.home.modeSaved', { name, count: Object.keys(entities).length })
  }
})

export const homeRulesTool = defineTool({
  name: 'home_rules',
  description:
    'Rules of the house. create_automation: a Home Assistant automation (trigger / condition / action in its format; for the simple and repetitive: schedules, “if there is motion turn on the light”; it spends no tokens). create_judgment: a rule where Alma wakes up, looks and decides (prompt) when a device changes state (“if the patio camera detects motion at night, look and tell me only if it is a person”). Also list / toggle / delete.',
  risk: 'write',
  standalone: true,
  schema: z.object({
    action: z.enum(['list', 'create_automation', 'create_judgment', 'toggle', 'delete']),
    name: z.string().optional(),
    description: z.string().optional(),
    trigger: z.array(z.record(z.string(), z.unknown())).optional().describe('Triggers in HA format: [{"trigger":"time","at":"23:00:00"}], [{"trigger":"state","entity_id":"binary_sensor.x","to":"on"}]'),
    condition: z.array(z.record(z.string(), z.unknown())).optional(),
    actions: z.array(z.record(z.string(), z.unknown())).optional().describe('Actions in HA format: [{"action":"light.turn_off","target":{"entity_id":"light.x"}}] or [{"action":"scene.turn_on","target":{"entity_id":"scene.noche"}}]'),
    watch: z.string().optional().describe('create_judgment: the device or sensor that wakes Alma (name or id)'),
    to: z.string().optional().describe('create_judgment: state it must change to (e.g. "on"); empty = any change'),
    between: z.tuple([z.string(), z.string()]).optional().describe('create_judgment: time window ["22:00","07:00"]'),
    cooldown_min: z.number().default(10).describe('create_judgment: minimum minutes between two wake-ups'),
    prompt: z.string().optional().describe('create_judgment: what Alma has to do when it fires'),
    id: z.string().optional().describe('toggle / delete: id of the rule'),
    enabled: z.boolean().optional()
  }),
  async run(input, ctx) {
    const service = live(ctx)
    const view = service.rulesView()
    switch (input.action) {
      case 'list':
        return (
          [
            ...view.automations.map((a) => `[automatic ${a.id}] ${a.name} — ${a.enabled ? 'active' : 'off'}`),
            ...view.judgment.map((r) => `[judgment ${r.id}] ${r.name} — ${r.enabled ? 'active' : 'off'} — ${r.entityId}${r.to ? ` → ${r.to}` : ''}${r.between ? ` between ${r.between.join('–')}` : ''}: ${r.prompt}`),
            ...view.watches.map((w) => `[watch ${w.id}] ${w.cameraName}: ${w.condition}`)
          ].join('\n') || toolText(ctx, 'tool.home.noRules')
        )
      case 'create_automation': {
        if (!input.name || !input.trigger?.length || !input.actions?.length) throw new ToolError('tool.home.automationNeeds')
        const id = await service.hub.saveAutomation({ alias: input.name, description: input.description ?? '', mode: 'single', triggers: input.trigger, conditions: input.condition ?? [], actions: input.actions })
        return toolText(ctx, 'tool.home.automationCreated', { name: input.name, id })
      }
      case 'create_judgment': {
        if (!input.name || !input.watch || !input.prompt) throw new ToolError('tool.home.judgmentNeeds')
        const [source] = exactlyOne(resolve(ctx, input.watch), input.watch)
        const rule = service.triggers.addJudgment({ name: input.name, entityId: source.sensors.find((s) => /motion|movimiento|occupancy|presence/i.test(`${s.deviceClass} ${s.name}`))?.entityId ?? source.entityId, to: input.to, between: input.between, cooldownMin: input.cooldown_min, prompt: input.prompt, createdBy: 'agent' })
        return toolText(ctx, 'tool.home.judgmentCreated', { name: rule.name, id: rule.id, entity: rule.entityId, when: rule.to ? `changes to “${rule.to}”` : 'changes', between: rule.between ? ` between ${rule.between[0]} and ${rule.between[1]}` : '', cooldown: rule.cooldownMin })
      }
      case 'toggle': {
        if (!input.id || input.enabled === undefined) throw new ToolError('tool.home.toggleNeeds')
        const automation = view.automations.find((a) => a.id === input.id)
        if (automation) await service.hub.toggleAutomation(automation.entityId, input.enabled)
        else if (view.judgment.some((r) => r.id === input.id)) service.triggers.toggleJudgment(input.id, input.enabled)
        else throw new ToolError('tool.home.noRule')
        return input.enabled ? toolText(ctx, 'tool.home.ruleOn') : toolText(ctx, 'tool.home.ruleOff')
      }
      case 'delete': {
        if (!input.id) throw new ToolError('tool.home.ruleId')
        if (view.automations.some((a) => a.id === input.id)) await service.hub.deleteAutomation(input.id)
        else if (!service.triggers.removeJudgment(input.id)) throw new ToolError('tool.home.noRule')
        return toolText(ctx, 'tool.home.ruleDeleted')
      }
    }
  }
})

export const homeHistoryTool = defineTool({
  name: 'home_history',
  description: 'Recent history of a device or sensor: “what time did the light go off?”, “was there motion last night?”.',
  risk: 'read',
  standalone: true,
  schema: z.object({ target: z.string(), hours: z.number().min(1).max(168).default(24) }),
  async run({ target, hours }, ctx) {
    const service = live(ctx)
    const things = resolve(ctx, target)
    const entityIds = things.flatMap((t) => [t.entityId, ...t.sensors.filter((s) => /motion|movimiento|occupancy|presence/i.test(`${s.deviceClass} ${s.name}`)).map((s) => s.entityId)])
    const history = await service.hub.history(entityIds, hours)
    const lines = Object.entries(history).flatMap(([id, points]) => [`${id}:`, ...points.slice(-40).map((p) => `  ${formatDateTime('en', new Date(p.at), 'short')} → ${p.state}`)])
    return lines.join('\n') || toolText(ctx, 'tool.home.noHistory')
  }
})

export const homeTools = [
  homeOverviewTool,
  homeFindTool,
  homeControlTool,
  homeSecureControlTool,
  homeCallServiceTool,
  homeAddDeviceTool,
  homeEditDeviceTool,
  homeRemoveDeviceTool,
  homePlanTool,
  homePlanEditTool,
  homePlanFromDrawingTool,
  homePlanFromImageTool,
  cameraLookTool,
  cameraPhotoTool,
  cameraWatchTool,
  homeSceneTool,
  homeModesTool,
  homeRulesTool,
  homeHistoryTool
]
