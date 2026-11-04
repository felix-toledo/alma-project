// What an agent can do with the house: see it, control it, add and rename devices, edit the plan, look through
// cameras, and make modes and rules. Everything goes through the same HomeService the window uses.
import * as z from 'zod/v4'
import { extractJson, isSensitive, planFromVision, type HomeThing } from '../../shared/home'
import { applyPlanOp, describePlan, PlanError, replaceFloorShape, type PlanOp } from '../home/plan'
import { fold } from '../home/model'
import { loadPicture, look, PLAN_QUESTION } from '../vision'
import { defineTool, ToolError, type ToolContext } from './types'

const OFF_MESSAGE = 'La domótica está apagada: se enciende en Configuración → Casa.'

function home(ctx: ToolContext): NonNullable<ToolContext['home']> {
  if (!ctx.home || !ctx.settings.home.enabled) throw new ToolError(OFF_MESSAGE)
  return ctx.home
}

/** Like home(), and also insists the house is connected right now. */
function live(ctx: ToolContext): NonNullable<ToolContext['home']> {
  const service = home(ctx)
  if (!service.hub.ready) {
    const { state, error, step } = service.engine.status()
    throw new ToolError(`La casa no está conectada (${state}${error ? `: ${error}` : step ? `: ${step}` : ''}). Si falta instalar el motor, se hace en Configuración → Casa.`)
  }
  return service
}

const ROOMLESS = 'Sin habitación'

function describeThing(thing: HomeThing): string {
  const parts: string[] = []
  if (!thing.available) parts.push('sin conexión')
  else if (thing.kind === 'light') parts.push(thing.on ? `encendida${typeof thing.attrs.brightness === 'number' ? ` ${Math.round((thing.attrs.brightness / 255) * 100)}%` : ''}` : 'apagada')
  else if (thing.on !== null) parts.push(thing.kind === 'cover' ? (thing.on ? 'abierta' : 'cerrada') : thing.on ? 'encendido' : 'apagado')
  else parts.push(thing.state)
  if (thing.kind === 'climate' && thing.attrs.current_temperature !== undefined) parts.push(`${thing.attrs.current_temperature}°`)
  if (thing.kind === 'speaker' && thing.attrs.media_title) parts.push(`suena «${thing.attrs.media_title}»`)
  for (const sensor of thing.sensors.slice(0, 3)) parts.push(`${sensor.name}: ${sensor.state}${sensor.unit ?? ''}`)
  return `${thing.name} [${thing.kind}] ${parts.join(', ')} · id ${thing.entityId}`
}

/** The things a person means by `target`; says what's available when nothing matches. */
function resolve(ctx: ToolContext, target: string, options: { kinds?: HomeThing['kind'][] } = {}): HomeThing[] {
  const { hub } = live(ctx)
  const matches = hub.find(target).filter((t) => !options.kinds || options.kinds.includes(t.kind))
  if (!matches.length) {
    const all = hub.snapshot().things.filter((t) => !options.kinds || options.kinds.includes(t.kind))
    throw new ToolError(`No encontré «${target}». Hay: ${all.map((t) => t.name).join(', ') || '(ningún dispositivo todavía)'}.`)
  }
  return matches
}

function exactlyOne(things: HomeThing[], target: string, all?: boolean): HomeThing[] {
  if (things.length > 1 && !all) {
    throw new ToolError(`«${target}» coincide con ${things.length} dispositivos: ${things.map((t) => `${t.name} (${t.entityId})`).join(', ')}. Pasá el id exacto, o all: true si querés todos.`)
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
  target: z.string().describe('Nombre, habitación o tipo ("luz de la cocina", "todas las luces del living") o el id exacto del dispositivo'),
  action: z.enum(['on', 'off', 'toggle', 'set', 'open', 'close', 'play', 'pause', 'stop', 'next', 'previous']).describe('set = ajustar valores sin cambiar el encendido (brillo, volumen, posición, temperatura)'),
  brightness: z.number().min(0).max(100).optional().describe('Luces: brillo en %'),
  color: z.string().optional().describe('Luces: nombre (rojo, azul, celeste…) '),
  rgb: z.tuple([z.number(), z.number(), z.number()]).optional().describe('Luces: color [r,g,b]'),
  temperature: z.union([z.string(), z.number()]).optional().describe('Luces: "calida", "neutra", "fria" o kelvin'),
  position: z.number().min(0).max(100).optional().describe('Persianas: % abierta'),
  volume: z.number().min(0).max(100).optional().describe('Parlantes: volumen %'),
  percentage: z.number().min(0).max(100).optional().describe('Ventiladores: velocidad %'),
  setpoint: z.number().optional().describe('Aire/calefacción: temperatura objetivo'),
  all: z.boolean().optional().describe('true para actuar sobre todos los que coincidan')
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
    if (!rgb) throw new ToolError(`No conozco el color «${input.color}». Probá con ${Object.keys(COLORS).join(', ')} o pasá rgb.`)
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
      if (domain !== 'media_player') throw new ToolError(`${thing.name} no es un reproductor.`)
      const names = { play: 'media_play', pause: 'media_pause', stop: 'media_stop', next: 'media_next_track', previous: 'media_previous_track' } as const
      calls.push({ service: `media_player/${names[input.action]}`, data: {} })
      break
    }
  }
  if (domain === 'media_player' && input.volume !== undefined && !calls.some((c) => c.service.endsWith('volume_set'))) calls.push({ service: 'media_player/volume_set', data: { volume_level: input.volume / 100 } })
  if (!calls.length) throw new ToolError(`No sé cómo hacer «${input.action}» con ${thing.name} (${thing.kind}). Probá home_call_service.`)
  return calls
}

export const homeOverviewTool = defineTool({
  name: 'home_overview',
  description: 'Muestra la casa: habitaciones, dispositivos con su estado actual, modos (escenas) y reglas. Usalo para saber qué hay antes de actuar o para responder «¿qué luces están prendidas?».',
  risk: 'read',
  standalone: true,
  schema: z.object({ room: z.string().optional().describe('Solo esta habitación') }),
  async run({ room }, ctx) {
    const service = home(ctx)
    if (!service.hub.ready) {
      const { state, error, step } = service.engine.status()
      return `La casa no está conectada todavía (${state}${error ? `: ${error}` : step ? `: ${step}` : ''}).`
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
      lines.join('\n') || 'No hay dispositivos todavía. Se agregan con home_add_device o desde Casa → Agregar dispositivo.',
      snapshot.scenes.length ? `Modos: ${snapshot.scenes.map((s) => s.name).join(', ')}` : '',
      `Reglas: ${rules.automations.length} automáticas, ${rules.judgment.length} con criterio de Alma, ${rules.watches.length} vigilancias de cámara.`
    ]
      .filter(Boolean)
      .join('\n')
  }
})

export const homeFindTool = defineTool({
  name: 'home_find',
  description: 'Busca dispositivos por palabras («luz cocina», «cámaras», «parlante del living») y devuelve cuáles son, con su id.',
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
    'Prende, apaga o ajusta luces, enchufes, interruptores, ventiladores, persianas, aire y parlantes. Se hace en el momento, sin preguntar. NO sirve para cerraduras, alarmas ni portones (usá home_secure_control). Si `target` coincide con varios dispositivos, aclará o pasá all: true.',
  risk: 'home',
  standalone: true,
  schema: ControlInput,
  async run(input, ctx) {
    const service = live(ctx)
    const things = exactlyOne(resolve(ctx, input.target), input.target, input.all)
    const blocked = things.filter((t) => isSensitive(t.kind, t.deviceClass))
    if (blocked.length) throw new ToolError(`${blocked.map((t) => t.name).join(', ')} es sensible (cerradura, alarma o portón): usá home_secure_control, que pide aprobación.`)
    for (const thing of things) {
      for (const call of serviceFor(thing, input)) await service.hub.control(thing.entityId, call.service, call.data)
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
    return things.map((t) => describeThing(service.hub.thing(t.id) ?? t)).join('\n')
  }
})

export const homeSecureControlTool = defineTool({
  name: 'home_secure_control',
  description: 'Maneja cerraduras, alarmas, sirenas y portones/garajes. Siempre le pide aprobación al usuario.',
  risk: 'publish',
  standalone: true,
  schema: z.object({
    target: z.string(),
    action: z.enum(['lock', 'unlock', 'open', 'close', 'arm_home', 'arm_away', 'disarm', 'trigger'])
  }),
  async run({ target, action }, ctx) {
    const service = live(ctx)
    const things = resolve(ctx, target).filter((t) => isSensitive(t.kind, t.deviceClass))
    if (!things.length) throw new ToolError(`«${target}» no es una cerradura, alarma ni portón. Para eso usá home_control.`)
    if (things.length > 1) throw new ToolError(`«${target}» coincide con varios: ${things.map((t) => `${t.name} (${t.entityId})`).join(', ')}. Pasá el id exacto.`)
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
    'Llama a cualquier servicio de Home Assistant (la puerta de atrás para todo lo que las otras herramientas no cubren). Ej.: domain "light", service "turn_on", entity_id "light.cocina", data {"effect":"rainbow"}. Para cerraduras, alarmas y portones pide aprobación igual que home_secure_control.',
  risk: 'write',
  standalone: true,
  schema: z.object({ domain: z.string(), service: z.string(), entity_id: z.union([z.string(), z.array(z.string())]).optional(), data: z.record(z.string(), z.unknown()).optional() }),
  async run({ domain, service, entity_id, data }, ctx) {
    const { hub } = live(ctx)
    if (['lock', 'alarm_control_panel', 'siren'].includes(domain)) throw new ToolError('Eso es sensible: usá home_secure_control.')
    await hub.callService(domain, service, data ?? {}, entity_id)
    return `Listo: ${domain}.${service}${entity_id ? ` sobre ${[entity_id].flat().join(', ')}` : ''}.`
  }
})

const AddInput = z.object({
  brand: z.string().optional().describe('Marca o integración a agregar: «tuya», «sonoff» (eWeLink), «onvif», «tplink» (Tapo y Kasa), «hue»… También sirve buscarla por nombre. Solo para el primer paso.'),
  flow_id: z.string().optional().describe('El flow_id que devolvió el paso anterior, para continuar'),
  data: z.record(z.string(), z.unknown()).optional().describe('Los datos que pide el paso (los nombres de campo de la lista)'),
  menu: z.string().optional().describe('Si el paso es un menú: la opción elegida')
})

function describeStep(step: Awaited<ReturnType<NonNullable<ToolContext['home']>['hub']['startFlow']>>): string {
  const lines = [`[flow_id ${step.flowId}] ${step.title}`]
  if (step.description) lines.push(step.description)
  switch (step.kind) {
    case 'form':
      lines.push(...Object.entries(step.errors).map(([field, error]) => `ERROR${field ? ` en ${field}` : ''}: ${error}`))
      if (step.qr) lines.push('Hay un código QR para escanear con la app del fabricante: ya está abierto en la ventana Casa. Pedile al usuario que lo escanee y confirme, y después llamá de nuevo con este flow_id y data {} .')
      if (step.fields.length) lines.push('Campos:', ...step.fields.map((f) => `- ${f.name} (${f.type}${f.required ? ', obligatorio' : ''})${f.label ? `: ${f.label}` : ''}${f.hint ? ` — ${f.hint}` : ''}${f.options ? ` · opciones: ${f.options.map((o) => `${o.value}=${o.label}`).join(' | ')}` : ''}${f.default !== undefined && f.default !== '' ? ` · por defecto ${JSON.stringify(f.default)}` : ''}`))
      else if (!step.qr) lines.push('(Sin campos: llamá de nuevo con este flow_id y data {} para continuar.)')
      break
    case 'menu':
      lines.push('Opciones (pasalas en `menu`):', ...(step.menu ?? []).map((m) => `- ${m.id}: ${m.label}`))
      break
    case 'external':
      lines.push(`El usuario tiene que abrir ${step.url} y completar el paso; después llamá de nuevo con este flow_id (sin data).`)
      break
    case 'done':
      lines.push('✔ Agregado. Los dispositivos nuevos aparecen en home_overview (pueden tardar unos segundos). Preguntale en qué habitación va cada uno y usá home_edit_device.')
      break
    case 'abort':
      lines.push(`✘ ${step.reason ?? 'No se pudo.'}`)
      break
  }
  return lines.join('\n')
}

export const homeAddDeviceTool = defineTool({
  name: 'home_add_device',
  description:
    'Agrega un dispositivo o una cuenta de marca (Tuya/Smart Life, eWeLink/Sonoff, cámaras Tapo/ONVIF, Hue…) siguiendo los pasos de Home Assistant. Primer llamado: solo `brand`. Cada respuesta dice qué datos pide; pedíselos al usuario (las contraseñas y códigos los escribe él) y seguí llamando con flow_id + data hasta que diga «Agregado». Si pide escanear un QR, el QR se muestra en la ventana Casa.',
  risk: 'write',
  standalone: true,
  schema: AddInput,
  async run(input, ctx) {
    const service = live(ctx)
    let step: Awaited<ReturnType<typeof service.hub.stepFlow>>
    if (input.flow_id) step = await service.hub.stepFlow(input.flow_id, input.menu !== undefined ? undefined : input.data, input.menu)
    else {
      if (!input.brand) throw new ToolError('Decime la marca o integración (brand).')
      const wanted = fold(input.brand)
      const all = await service.hub.integrations()
      const exact = all.find((i) => i.domain === wanted) ?? all.find((i) => fold(i.name) === wanted)
      const candidates = exact ? [exact] : all.filter((i) => fold(i.name).includes(wanted) || i.domain.includes(wanted))
      if (candidates.length !== 1) {
        throw new ToolError(candidates.length ? `«${input.brand}» coincide con varias: ${candidates.slice(0, 12).map((i) => `${i.name} (${i.domain})`).join(', ')}. Elegí una y pasá su dominio.` : `Home Assistant no conoce «${input.brand}». Marcas habituales: tuya, sonoff, onvif, tplink, hue, cast, shelly, wiz, esphome.`)
      }
      step = await service.hub.startFlow(candidates[0].domain)
    }
    if (step.qr || step.kind === 'external') ctx.home!.showFlow(step)
    return describeStep(step)
  }
})

export const homeEditDeviceTool = defineTool({
  name: 'home_edit_device',
  description: 'Le cambia el nombre a un dispositivo o lo pasa a otra habitación (se crea la habitación si no existe).',
  risk: 'write',
  standalone: true,
  schema: z.object({ target: z.string(), name: z.string().optional().describe('Nombre nuevo'), room: z.string().optional().describe('Habitación; vacío «» para dejarlo sin habitación') }),
  async run({ target, name, room }, ctx) {
    const service = live(ctx)
    const [thing] = exactlyOne(resolve(ctx, target), target)
    const areaId = room === undefined ? undefined : room.trim() ? await service.hub.ensureArea(room) : null
    await service.hub.updateThing(thing.id, { ...(name !== undefined ? { name } : {}), ...(areaId !== undefined ? { areaId } : {}) })
    return `Listo: ${name ?? thing.name}${room !== undefined ? ` ahora está en ${room || 'ninguna habitación'}` : ''}. (Si la habitación tiene lugar en el plano, el dispositivo aparece ahí.)`
  }
})

export const homeRemoveDeviceTool = defineTool({
  name: 'home_remove_device',
  description: 'Quita un dispositivo de la casa (si su integración no lo permite, lo oculta). Para quitar una cuenta entera (todos los dispositivos de una marca) el usuario lo hace desde Casa.',
  risk: 'write',
  standalone: true,
  schema: z.object({ target: z.string() }),
  async run({ target }, ctx) {
    const service = live(ctx)
    const [thing] = exactlyOne(resolve(ctx, target), target)
    return `${thing.name}: ${await service.hub.removeThing(thing.id)}`
  }
})

export const homePlanTool = defineTool({
  name: 'home_plan',
  description: 'Muestra el plano de la casa: pisos, habitaciones (posición y tamaño en cm) y dónde está cada dispositivo. Sirve para entender «la luz de al lado de la puerta» o «las de arriba».',
  risk: 'read',
  standalone: true,
  schema: z.object({}),
  async run(_input, ctx) {
    const service = home(ctx)
    return describePlan(service.plan.get(), service.hub.ready ? service.hub.snapshot().things : [])
  }
})

const Point = z.tuple([z.number(), z.number()])
const Rect = z.tuple([z.number(), z.number(), z.number(), z.number()]).describe('[x, y, ancho, alto] en cm')
const PlanOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_floor'), name: z.string() }),
  z.object({ op: z.literal('rename_floor'), floor: z.string(), name: z.string() }),
  z.object({ op: z.literal('remove_floor'), floor: z.string() }),
  z.object({ op: z.literal('add_room'), floor: z.string().optional(), name: z.string(), rect: Rect.optional(), polygon: z.array(Point).optional() }),
  z.object({ op: z.literal('rename_room'), floor: z.string().optional(), room: z.string(), name: z.string() }),
  z.object({ op: z.literal('set_room_shape'), floor: z.string().optional(), room: z.string(), rect: Rect.optional(), polygon: z.array(Point).optional() }),
  z.object({ op: z.literal('remove_room'), floor: z.string().optional(), room: z.string() }),
  z.object({ op: z.literal('add_door'), floor: z.string().optional(), a: Point, b: Point }),
  z.object({ op: z.literal('place'), floor: z.string().optional(), ref: z.string().describe('id o nombre del dispositivo'), room: z.string().optional(), x: z.number().optional(), y: z.number().optional() }),
  z.object({ op: z.literal('unplace'), ref: z.string() })
])

export const homePlanEditTool = defineTool({
  name: 'home_plan_edit',
  description:
    'Edita el plano de la casa: pisos, habitaciones (rectángulos o polígonos en cm), puertas y la ubicación de los dispositivos. Varias operaciones por llamado, en orden. Una habitación nueva crea su área en Home Assistant; ubicar un dispositivo en una habitación lo pasa a esa habitación.',
  risk: 'home',
  standalone: true,
  schema: z.object({ ops: z.array(PlanOpSchema).min(1) }),
  async run({ ops }, ctx) {
    const service = home(ctx)
    const things = service.hub.ready ? service.hub.snapshot().things : []
    let plan = service.plan.get()
    try {
      for (const op of ops) {
        // The agent may name a device instead of giving its id.
        if (op.op === 'place' || op.op === 'unplace') {
          const thing = things.find((t) => t.id === op.ref || t.entityId === op.ref) ?? resolve(ctx, op.ref)[0]
          op.ref = thing.id
        }
        plan = applyPlanOp(plan, op as PlanOp, things)
      }
    } catch (error) {
      if (error instanceof PlanError) throw new ToolError(error.message)
      throw error
    }
    plan = await service.savePlan(plan)
    return describePlan(plan, things)
  }
})

export const homePlanFromDrawingTool = defineTool({
  name: 'home_plan_from_drawing',
  description: 'Arma las habitaciones del plano a partir de un dibujo de Excalidraw del vault: cada rectángulo es una habitación y el texto adentro, su nombre. Reemplaza las habitaciones del piso.',
  risk: 'home',
  standalone: true,
  schema: z.object({ path: z.string().describe('Ruta del .excalidraw en el vault'), floor: z.string().optional() }),
  async run({ path, floor }, ctx) {
    const service = home(ctx)
    try {
      const plan = await service.planFromDrawing(path, floor ? (service.plan.get().floors.find((f) => fold(f.name) === fold(floor))?.id ?? floor) : undefined)
      return describePlan(plan, service.hub.ready ? service.hub.snapshot().things : [])
    } catch (error) {
      if (error instanceof PlanError) throw new ToolError(error.message)
      throw error
    }
  }
})

export function pictureRoots(ctx: ToolContext): string[] {
  return [ctx.inboxDir, ctx.knowledge?.root, ctx.workspace].filter((p): p is string => !!p)
}

export const homePlanFromImageTool = defineTool({
  name: 'home_plan_from_image',
  description: 'Arma las habitaciones del plano mirando una imagen: un plano, un croquis o una foto de la casa vista desde arriba. Reemplaza las habitaciones del piso; el usuario después las puede ajustar en Casa.',
  risk: 'home',
  standalone: true,
  schema: z.object({ path: z.string().describe('Ruta de la imagen (la que te mandó el usuario)'), hint: z.string().optional().describe('Datos del usuario: nombres de las habitaciones, medidas, cuántos pisos…'), floor: z.string().optional() }),
  async run({ path, hint, floor }, ctx) {
    const service = home(ctx)
    const picture = loadPicture(path, pictureRoots(ctx))
    const answer = await look(ctx.settings, [picture], PLAN_QUESTION(hint ?? ''), ctx.signal)
    let plan: ReturnType<typeof replaceFloorShape>
    try {
      const { rooms, doors } = planFromVision(extractJson(answer.text), picture.width && picture.height ? picture.width / picture.height : 1)
      const floors = service.plan.get().floors
      plan = replaceFloorShape(service.plan.get(), floor ? (floors.find((f) => fold(f.name) === fold(floor))?.id ?? floor) : undefined, rooms, doors, { kind: 'photo', ref: path })
    } catch (error) {
      throw new ToolError(`No pude leer el plano de la imagen: ${(error as Error).message}. Probá con una imagen más clara o armalo con home_plan_edit.`)
    }
    const saved = await service.savePlan(plan)
    return `${describePlan(saved, service.hub.ready ? service.hub.snapshot().things : [])}\n\nEl plano ya se ve en Casa; el usuario puede corregirlo ahí.`
  }
})

export const lookAtImageTool = defineTool({
  name: 'look_at_image',
  description: 'Mira una imagen (foto que mandó el usuario, una captura, una imagen del vault) y responde una pregunta sobre ella. Para fotos de ambientes: qué habitación parece, qué dispositivos se ven (lámparas, TV, parlantes).',
  risk: 'read',
  standalone: true,
  schema: z.object({ path: z.string(), question: z.string().default('Describí lo que ves, con detalle útil para una casa inteligente.') }),
  async run({ path, question }, ctx) {
    return (await look(ctx.settings, [loadPicture(path, pictureRoots(ctx))], question, ctx.signal)).text
  }
})

export const cameraLookTool = defineTool({
  name: 'camera_look',
  description: 'Saca una foto de una cámara de la casa ahora y responde qué se ve (o la pregunta que hagas). Con send_telegram manda la foto al celular del usuario.',
  risk: 'write',
  standalone: true,
  schema: z.object({ camera: z.string().describe('Nombre o habitación de la cámara'), question: z.string().default('¿Qué se ve? ¿Hay personas, animales o algo fuera de lo normal?'), send_telegram: z.boolean().optional() }),
  async run({ camera, question, send_telegram }, ctx) {
    const service = live(ctx)
    const [thing] = exactlyOne(resolve(ctx, camera, { kinds: ['camera'] }), camera)
    const jpeg = await service.hub.cameraSnapshot(thing.entityId)
    service.saveStill(thing.entityId, jpeg)
    // The picture matters more than its description: if the vision model fails (no credit, no key), the photo still goes out.
    let text: string
    let failure = ''
    try {
      text = (await look(ctx.settings, [{ mediaType: 'image/jpeg', data: jpeg.toString('base64') }], `Cámara «${thing.name}». ${question}`, ctx.signal)).text
    } catch (error) {
      failure = (error as Error).message
      text = '(No pude analizar la imagen.)'
    }
    let sent = ''
    if (send_telegram) sent = (await ctx.sendTelegramPhoto?.(jpeg, `${thing.name}: ${text}`.slice(0, 1000))) ? '\n(Foto enviada por Telegram.)' : '\n(No pude mandar la foto por Telegram: no está conectado.)'
    return failure ? `${thing.name}: no pude analizar la imagen (${failure}).${sent}` : `${thing.name}: ${text}${sent}`
  }
})

export const cameraPhotoTool = defineTool({
  name: 'camera_photo',
  description:
    'Saca una foto de una cámara de la casa y se la MANDA al usuario por Telegram, sin analizarla (no gasta visión). Usalo cuando pida «mandame una foto / una captura de la cámara». Si además quiere saber qué se ve, usá camera_look.',
  risk: 'write',
  standalone: true,
  schema: z.object({ camera: z.string().describe('Nombre o habitación de la cámara') }),
  async run({ camera }, ctx) {
    const service = live(ctx)
    const [thing] = exactlyOne(resolve(ctx, camera, { kinds: ['camera'] }), camera)
    const jpeg = await service.hub.cameraSnapshot(thing.entityId)
    const file = service.saveStill(thing.entityId, jpeg)
    const sent = await ctx.sendTelegramPhoto?.(jpeg, thing.name).catch((error: Error) => {
      throw new ToolError(`Telegram no aceptó la foto: ${error.message}`)
    })
    return sent ? `Foto de ${thing.name} enviada por Telegram.` : `Saqué la foto de ${thing.name} (guardada en ${file}) pero Telegram no está conectado, así que no pude mandarla.`
  }
})

export const cameraWatchTool = defineTool({
  name: 'camera_watch',
  description:
    'Vigila una cámara por un tiempo limitado: cada tanto mira la imagen y avisa al usuario (notificación y Telegram, con foto) cuando se cumple lo que pidió. Cada mirada gasta tokens de visión, así que usá intervalos razonables (30–120 s) y tiempos acotados. action: start / stop / list.',
  risk: 'write',
  standalone: true,
  schema: z.object({
    action: z.enum(['start', 'stop', 'list']),
    camera: z.string().optional(),
    condition: z.string().optional().describe('Qué buscar: «llega un paquete a la puerta», «aparece una persona»'),
    minutes: z.number().min(1).max(360).default(60),
    every_seconds: z.number().min(10).max(900).default(60),
    repeat: z.boolean().default(false).describe('Seguir vigilando después de avisar'),
    id: z.string().optional().describe('stop: id de la vigilancia')
  }),
  async run(input, ctx) {
    const service = live(ctx)
    if (input.action === 'list') {
      const watches = service.triggers.rules().watches
      return watches.length ? watches.map((w) => `${w.id}: ${w.cameraName} — «${w.condition}» cada ${w.everySec}s, ${w.checks} miradas, hasta ${new Date(w.until).toLocaleTimeString('es')}${w.lastNote ? ` · última: ${w.lastNote}` : ''}`).join('\n') : 'No hay vigilancias activas.'
    }
    if (input.action === 'stop') {
      const watches = service.triggers.rules().watches
      const target = input.id ?? (watches.length === 1 ? watches[0].id : undefined)
      if (!target) throw new ToolError(`Decime cuál: ${watches.map((w) => `${w.id} (${w.cameraName})`).join(', ') || 'no hay ninguna activa'}.`)
      return service.triggers.stopWatch(target) ? 'Vigilancia detenida.' : 'Esa vigilancia no existe.'
    }
    if (!input.camera || !input.condition) throw new ToolError('Para empezar necesito la cámara (camera) y qué buscar (condition).')
    const [thing] = exactlyOne(resolve(ctx, input.camera, { kinds: ['camera'] }), input.camera)
    const watch = service.triggers.startWatch({ entityId: thing.entityId, cameraName: thing.name, condition: input.condition, everySec: input.every_seconds, minutes: input.minutes, repeat: input.repeat })
    const looks = Math.ceil((input.minutes * 60) / watch.everySec)
    return `Vigilando ${thing.name} (id ${watch.id}): «${input.condition}», cada ${watch.everySec} s durante ${input.minutes} min (hasta ${looks} miradas). Aviso por notificación y Telegram cuando se cumpla.`
  }
})

export const homeSceneTool = defineTool({
  name: 'home_scene',
  description: 'Activa un modo (escena) de la casa por su nombre: «Noche», «Cine», «Me fui». Los modos disponibles están en home_overview.',
  risk: 'home',
  standalone: true,
  schema: z.object({ name: z.string() }),
  async run({ name }, ctx) {
    const { hub } = live(ctx)
    const scenes = hub.scenes()
    const wanted = fold(name)
    const scene = scenes.find((s) => fold(s.name) === wanted || s.entityId === name) ?? scenes.filter((s) => fold(s.name).includes(wanted))[0]
    if (!scene) throw new ToolError(`No hay un modo «${name}». Modos: ${scenes.map((s) => s.name).join(', ') || '(ninguno todavía; se crean con home_modes)'}.`)
    await hub.callService('scene', 'turn_on', {}, scene.entityId)
    return `Modo «${scene.name}» activado.`
  }
})

export const homeModesTool = defineTool({
  name: 'home_modes',
  description:
    'Crea, muestra o borra modos (escenas). Para crear: `devices` con lo que debe hacer cada dispositivo ({"luz cocina": {"state":"on","brightness_pct":30}, "luz pasillo": {"state":"off"}}), o `from_current` con los dispositivos cuyo estado actual se guarda tal cual.',
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
    if (action === 'list') return hub.scenes().map((s) => s.name).join(', ') || 'No hay modos.'
    if (!name) throw new ToolError('Falta el nombre del modo.')
    const scene = hub.scenes().find((s) => fold(s.name) === fold(name))
    if (action === 'show') return scene ? JSON.stringify(await hub.sceneConfig(scene.entityId), null, 2) : `No hay un modo «${name}».`
    if (action === 'delete') {
      if (!scene) throw new ToolError(`No hay un modo «${name}».`)
      await hub.deleteScene(scene.entityId)
      return `Modo «${name}» borrado.`
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
    if (!Object.keys(entities).length) throw new ToolError('Decime qué hace cada dispositivo (devices) o cuáles guardar tal cual están (from_current).')
    await hub.saveScene(name, entities, scene ? String(hub.state(scene.entityId)?.attributes.id ?? '') || undefined : undefined)
    return `Modo «${name}» guardado con ${Object.keys(entities).length} dispositivos.`
  }
})

export const homeRulesTool = defineTool({
  name: 'home_rules',
  description:
    'Reglas de la casa. create_automation: una automatización de Home Assistant (trigger / condition / action en su formato; lo simple y repetitivo: horarios, «si hay movimiento prendé la luz»; no gasta tokens). create_judgment: una regla donde Alma despierta, mira y decide (prompt) cuando un dispositivo cambia de estado («si la cámara del patio detecta movimiento de noche, mirá y avisame solo si es una persona»). También list / toggle / delete.',
  risk: 'write',
  standalone: true,
  schema: z.object({
    action: z.enum(['list', 'create_automation', 'create_judgment', 'toggle', 'delete']),
    name: z.string().optional(),
    description: z.string().optional(),
    trigger: z.array(z.record(z.string(), z.unknown())).optional().describe('Disparadores en formato HA: [{"trigger":"time","at":"23:00:00"}], [{"trigger":"state","entity_id":"binary_sensor.x","to":"on"}]'),
    condition: z.array(z.record(z.string(), z.unknown())).optional(),
    actions: z.array(z.record(z.string(), z.unknown())).optional().describe('Acciones en formato HA: [{"action":"light.turn_off","target":{"entity_id":"light.x"}}] o [{"action":"scene.turn_on","target":{"entity_id":"scene.noche"}}]'),
    watch: z.string().optional().describe('create_judgment: el dispositivo o sensor que despierta a Alma (nombre o id)'),
    to: z.string().optional().describe('create_judgment: estado al que debe pasar (p. ej. "on"); vacío = cualquier cambio'),
    between: z.tuple([z.string(), z.string()]).optional().describe('create_judgment: franja horaria ["22:00","07:00"]'),
    cooldown_min: z.number().default(10).describe('create_judgment: minutos mínimos entre dos despertares'),
    prompt: z.string().optional().describe('create_judgment: qué tiene que hacer Alma cuando se dispare'),
    id: z.string().optional().describe('toggle / delete: id de la regla'),
    enabled: z.boolean().optional()
  }),
  async run(input, ctx) {
    const service = live(ctx)
    const view = service.rulesView()
    switch (input.action) {
      case 'list':
        return (
          [
            ...view.automations.map((a) => `[automática ${a.id}] ${a.name} — ${a.enabled ? 'activa' : 'apagada'}`),
            ...view.judgment.map((r) => `[con criterio ${r.id}] ${r.name} — ${r.enabled ? 'activa' : 'apagada'} — ${r.entityId}${r.to ? ` → ${r.to}` : ''}${r.between ? ` entre ${r.between.join('–')}` : ''}: ${r.prompt}`),
            ...view.watches.map((w) => `[vigilancia ${w.id}] ${w.cameraName}: ${w.condition}`)
          ].join('\n') || 'No hay reglas.'
        )
      case 'create_automation': {
        if (!input.name || !input.trigger?.length || !input.actions?.length) throw new ToolError('Una automatización necesita name, trigger y actions.')
        const id = await service.hub.saveAutomation({ alias: input.name, description: input.description ?? '', mode: 'single', triggers: input.trigger, conditions: input.condition ?? [], actions: input.actions })
        return `Automatización «${input.name}» creada (id ${id}) y activa.`
      }
      case 'create_judgment': {
        if (!input.name || !input.watch || !input.prompt) throw new ToolError('Una regla con criterio necesita name, watch (qué dispositivo la despierta) y prompt (qué hacer).')
        const [source] = exactlyOne(resolve(ctx, input.watch), input.watch)
        const rule = service.triggers.addJudgment({ name: input.name, entityId: source.sensors.find((s) => /motion|movimiento|occupancy|presence/i.test(`${s.deviceClass} ${s.name}`))?.entityId ?? source.entityId, to: input.to, between: input.between, cooldownMin: input.cooldown_min, prompt: input.prompt, createdBy: 'agent' })
        return `Regla «${rule.name}» creada (id ${rule.id}): cuando ${rule.entityId} ${rule.to ? `pase a «${rule.to}»` : 'cambie'}${rule.between ? ` entre ${rule.between[0]} y ${rule.between[1]}` : ''}, me despierto y hago lo que dice. Espera al menos ${rule.cooldownMin} min entre una y otra.`
      }
      case 'toggle': {
        if (!input.id || input.enabled === undefined) throw new ToolError('Falta id y enabled.')
        const automation = view.automations.find((a) => a.id === input.id)
        if (automation) await service.hub.toggleAutomation(automation.entityId, input.enabled)
        else if (view.judgment.some((r) => r.id === input.id)) service.triggers.toggleJudgment(input.id, input.enabled)
        else throw new ToolError('No hay una regla con ese id.')
        return input.enabled ? 'Regla activada.' : 'Regla apagada.'
      }
      case 'delete': {
        if (!input.id) throw new ToolError('Falta el id de la regla.')
        if (view.automations.some((a) => a.id === input.id)) await service.hub.deleteAutomation(input.id)
        else if (!service.triggers.removeJudgment(input.id)) throw new ToolError('No hay una regla con ese id.')
        return 'Regla borrada.'
      }
    }
  }
})

export const homeHistoryTool = defineTool({
  name: 'home_history',
  description: 'Historial reciente de un dispositivo o sensor: «¿a qué hora se apagó la luz?», «¿hubo movimiento anoche?».',
  risk: 'read',
  standalone: true,
  schema: z.object({ target: z.string(), hours: z.number().min(1).max(168).default(24) }),
  async run({ target, hours }, ctx) {
    const service = live(ctx)
    const things = resolve(ctx, target)
    const entityIds = things.flatMap((t) => [t.entityId, ...t.sensors.filter((s) => /motion|movimiento|occupancy|presence/i.test(`${s.deviceClass} ${s.name}`)).map((s) => s.entityId)])
    const history = await service.hub.history(entityIds, hours)
    const lines = Object.entries(history).flatMap(([id, points]) => [`${id}:`, ...points.slice(-40).map((p) => `  ${new Date(p.at).toLocaleString('es')} → ${p.state}`)])
    return lines.join('\n') || 'Sin cambios en ese período.'
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
