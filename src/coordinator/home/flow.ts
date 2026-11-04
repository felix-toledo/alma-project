// Config flows: how Home Assistant adds a device. It asks for data one form at a time (an account, an IP, a QR to
// scan); this turns each step into the neutral FlowStep the window draws, so any brand works without code of its own.
import QRCode from 'qrcode'
import type { FlowField, FlowStep, HomeIntegration } from '../../shared/home'
import type { HaClient } from './ha'

interface RawField {
  name?: string
  type?: string
  required?: boolean
  optional?: boolean
  default?: unknown
  description?: { suggested_value?: unknown }
  options?: unknown
  valueMin?: number
  valueMax?: number
  selector?: Record<string, Record<string, unknown> | null>
  schema?: RawField[]
}

interface RawFlow {
  type: string
  flow_id: string
  handler: string
  step_id?: string
  data_schema?: RawField[] | null
  errors?: Record<string, string> | null
  description_placeholders?: Record<string, string> | null
  menu_options?: string[] | Record<string, string>
  progress_action?: string
  url?: string
  reason?: string
  result?: { entry_id?: string } | string
  title?: string
}

type Translations = Record<string, string>

const translationCache = new Map<string, Translations>()
let integrationsCache: HomeIntegration[] | null = null

async function translationsFor(ha: HaClient, handler: string): Promise<Translations> {
  let cached = translationCache.get(handler)
  if (!cached) {
    const response = await ha.call<{ resources: Translations }>({ type: 'frontend/get_translations', language: 'es', category: 'config', integration: [handler] }).catch(() => ({ resources: {} }))
    cached = response.resources
    translationCache.set(handler, cached)
  }
  return cached
}

const prettify = (name: string): string => (name.charAt(0).toUpperCase() + name.slice(1)).replace(/[_.]/g, ' ')

function fillPlaceholders(text: string, placeholders: Record<string, string> | null | undefined): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => placeholders?.[key] ?? match)
}

function optionList(raw: unknown, label: (value: string) => string | undefined): { value: string; label: string }[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      if (Array.isArray(item)) return { value: String(item[0]), label: String(item[1]) }
      if (item && typeof item === 'object') return { value: String((item as { value: unknown }).value), label: String((item as { label?: unknown }).label ?? (item as { value: unknown }).value) }
      return { value: String(item), label: label(String(item)) ?? String(item) }
    })
  }
  if (raw && typeof raw === 'object') return Object.entries(raw as Record<string, unknown>).map(([value, text]) => ({ value, label: String(text) }))
  return []
}

/** The fields of a schema; sections ("expandable") are flattened to `section.field`. A QR selector becomes `qr`. */
export function mapFields(schema: RawField[] | null | undefined, labelOf: (name: string) => string | undefined, prefix = ''): { fields: FlowField[]; qr?: string } {
  const fields: FlowField[] = []
  let qr: string | undefined
  for (const raw of schema ?? []) {
    const name = `${prefix}${raw.name ?? ''}`
    if (raw.type === 'expandable' && raw.schema) {
      const inner = mapFields(raw.schema, labelOf, `${raw.name}.`)
      fields.push(...inner.fields)
      qr ??= inner.qr
      continue
    }
    const selector = raw.selector ? Object.entries(raw.selector)[0] : undefined
    const kind = selector?.[0]
    const config = (selector?.[1] ?? {}) as Record<string, unknown>
    const base = { name, required: raw.required === true && raw.optional !== true, default: raw.default ?? raw.description?.suggested_value }
    if (kind === 'qr_code') {
      qr = String(config.data ?? '')
      continue
    }
    if (raw.type === 'constant') continue
    if (kind === 'text') fields.push({ ...base, type: config.type === 'password' ? 'password' : 'string' })
    else if (kind === 'number') {
      const step = config.step
      fields.push({ ...base, type: step === 'any' || (typeof step === 'number' && !Number.isInteger(step)) ? 'float' : 'integer', min: config.min as number | undefined, max: config.max as number | undefined })
    } else if (kind === 'boolean') fields.push({ ...base, type: 'boolean' })
    else if (kind === 'select') fields.push({ ...base, type: config.multiple ? 'multi_select' : 'select', options: optionList(config.options, () => undefined) })
    else if (kind) fields.push({ ...base, type: 'string' })
    else if (raw.type === 'string') fields.push({ ...base, type: /password|token|secret/i.test(name) ? 'password' : 'string' })
    else if (raw.type === 'integer') fields.push({ ...base, type: 'integer', min: raw.valueMin, max: raw.valueMax })
    else if (raw.type === 'float') fields.push({ ...base, type: 'float', min: raw.valueMin, max: raw.valueMax })
    else if (raw.type === 'boolean') fields.push({ ...base, type: 'boolean' })
    else if (raw.type === 'select') fields.push({ ...base, type: 'select', options: optionList(raw.options, () => undefined) })
    else if (raw.type === 'multi_select') fields.push({ ...base, type: 'multi_select', options: optionList(raw.options, () => undefined) })
    else fields.push({ ...base, type: 'unknown' })
  }
  return { fields, qr }
}

/** `a.b: 1` → `{ a: { b: 1 } }`: what HA expects for the fields inside a section. */
export function nestData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    const [head, ...rest] = key.split('.')
    if (!rest.length) out[key] = value
    else ((out[head] ??= {}) as Record<string, unknown>)[rest.join('.')] = value
  }
  return out
}

async function toStep(ha: HaClient, raw: RawFlow): Promise<FlowStep> {
  const tr = await translationsFor(ha, raw.handler)
  const base = `component.${raw.handler}.config`
  const step = raw.step_id ?? ''
  const text = (key: string): string | undefined => tr[`${base}.${key}`]
  const placeholders = raw.description_placeholders
  const out: FlowStep = { flowId: raw.flow_id, handler: raw.handler, kind: 'form', stepId: step, title: '', description: '', fields: [], errors: {} }
  const describe = (key: string): string => fillPlaceholders(text(key) ?? '', placeholders).trim()

  switch (raw.type) {
    case 'form': {
      const { fields, qr } = mapFields(raw.data_schema, (name) => text(`step.${step}.data.${name}`))
      out.title = describe(`step.${step}.title`) || prettify(raw.handler)
      out.description = describe(`step.${step}.description`)
      out.fields = fields.map((field) => ({ ...field, label: text(`step.${step}.data.${field.name}`), hint: text(`step.${step}.data_description.${field.name}`) }) as FlowField)
      if (qr) out.qr = await QRCode.toDataURL(qr, { scale: 6, margin: 2 })
      for (const [field, code] of Object.entries(raw.errors ?? {})) out.errors[field] = fillPlaceholders(text(`error.${code}`) ?? code, placeholders)
      return out
    }
    case 'menu': {
      const options = Array.isArray(raw.menu_options) ? raw.menu_options : Object.keys(raw.menu_options ?? {})
      out.kind = 'menu'
      out.title = describe(`step.${step}.title`) || prettify(raw.handler)
      out.description = describe(`step.${step}.description`)
      out.menu = options.map((id) => ({ id, label: text(`step.${step}.menu_options.${id}`) ?? (Array.isArray(raw.menu_options) ? prettify(id) : String((raw.menu_options as Record<string, string>)[id])) }))
      return out
    }
    case 'progress':
      out.kind = 'progress'
      out.title = describe(`step.${step}.title`) || prettify(raw.handler)
      out.description = fillPlaceholders(text(`progress.${raw.progress_action ?? ''}`) ?? 'Trabajando…', placeholders)
      return out
    case 'external':
      out.kind = 'external'
      out.url = raw.url
      out.title = describe(`step.${step}.title`) || prettify(raw.handler)
      out.description = describe(`step.${step}.description`) || 'Abrí el enlace, completá el paso y volvé acá.'
      return out
    case 'create_entry':
      out.kind = 'done'
      out.title = raw.title ?? prettify(raw.handler)
      out.entryId = typeof raw.result === 'object' ? raw.result?.entry_id : undefined
      return out
    case 'abort':
      out.kind = 'abort'
      out.reason = fillPlaceholders(text(`abort.${raw.reason ?? ''}`) ?? raw.reason ?? 'Se canceló.', placeholders)
      out.title = prettify(raw.handler)
      return out
    default:
      out.kind = 'abort'
      out.reason = `Home Assistant pidió un paso que Alma todavía no sabe mostrar (${raw.type}). Usá el botón avanzado para completarlo.`
      return out
  }
}

/** Every integration that can be added from the UI, with its Spanish name. */
export async function listIntegrations(ha: HaClient): Promise<HomeIntegration[]> {
  if (integrationsCache) return integrationsCache
  const domains = await ha.rest<string[]>('GET', '/api/config/config_entries/flow_handlers?type=integration')
  const titles = await ha
    .call<{ resources: Translations }>({ type: 'frontend/get_translations', language: 'es', category: 'title', integration: domains })
    .catch(() => ({ resources: {} as Translations }))
  // Custom integrations (eWeLink's SonoffLAN) aren't in that list: the descriptions have them.
  const custom = await ha
    .call<{ custom?: { integration?: Record<string, { config_flow?: boolean; name?: string }> } }>({ type: 'integration/descriptions' })
    .then((d) => Object.entries(d.custom?.integration ?? {}).filter(([, info]) => info.config_flow).map(([domain, info]) => ({ domain, name: info.name ?? prettify(domain) })))
    .catch(() => [] as HomeIntegration[])
  integrationsCache = [...domains.filter((d) => !custom.some((c) => c.domain === d)).map((domain) => ({ domain, name: titles.resources[`component.${domain}.title`] ?? prettify(domain) })), ...custom].sort((a, b) => a.name.localeCompare(b.name, 'es'))
  return integrationsCache
}

/** Forgets what was cached (after installing a custom component, the list changes). */
export function resetFlowCache(): void {
  integrationsCache = null
  translationCache.clear()
}

export async function startFlow(ha: HaClient, handler: string): Promise<FlowStep> {
  const raw = await ha.rest<RawFlow>('POST', '/api/config/config_entries/flow', { handler, show_advanced_options: false })
  return settle(ha, raw)
}

/** Sends a step's data (or, with none, asks where the flow stands: external steps and progress). */
export async function stepFlow(ha: HaClient, flowId: string, data?: Record<string, unknown>, menu?: string): Promise<FlowStep> {
  const raw =
    menu !== undefined
      ? await ha.rest<RawFlow>('POST', `/api/config/config_entries/flow/${flowId}`, { next_step_id: menu })
      : data !== undefined
        ? await ha.rest<RawFlow>('POST', `/api/config/config_entries/flow/${flowId}`, nestData(data))
        : await ha.rest<RawFlow>('GET', `/api/config/config_entries/flow/${flowId}`)
  return settle(ha, raw)
}

export async function abortFlow(ha: HaClient, flowId: string): Promise<void> {
  await ha.rest('DELETE', `/api/config/config_entries/flow/${flowId}`).catch(() => undefined)
}

/** A "progress" step means HA is working (pairing, logging in): wait for it instead of making the window poll. */
async function settle(ha: HaClient, first: RawFlow): Promise<FlowStep> {
  let raw = first
  for (let i = 0; i < 40 && raw.type === 'progress'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    raw = await ha.rest<RawFlow>('GET', `/api/config/config_entries/flow/${raw.flow_id}`)
  }
  return toStep(ha, raw)
}
