// Companies: pure helpers shared by the coordinator (who may talk to whom, spend) and the window (org chart, templates).
import { DEFAULT_META_MODEL } from './defaults'
import type { AgentProfile, Company, CompanyMember, ProviderId, Usage } from './types'

export const BOARD = 'user'

/** The member's chain of command, nearest boss first (stops at the board). */
export function chainOfCommand(company: Company, memberId: string): CompanyMember[] {
  const byId = new Map(company.members.map((m) => [m.id, m]))
  const chain: CompanyMember[] = []
  const seen = new Set<string>([memberId])
  for (let boss = byId.get(memberId)?.reportsTo; boss && !seen.has(boss); boss = byId.get(boss)?.reportsTo) {
    seen.add(boss)
    const member = byId.get(boss)
    if (!member) break
    chain.push(member)
  }
  return chain
}

/** Everyone below the member, at any depth. */
export function subordinates(company: Company, memberId: string): CompanyMember[] {
  const out: CompanyMember[] = []
  const queue = [memberId]
  const seen = new Set(queue)
  while (queue.length) {
    const boss = queue.shift()!
    for (const member of company.members) {
      if (member.reportsTo === boss && !seen.has(member.id)) {
        seen.add(member.id)
        out.push(member)
        queue.push(member.id)
      }
    }
  }
  return out
}

export const directReports = (company: Company, memberId: string): CompanyMember[] => company.members.filter((m) => m.reportsTo === memberId)

/** Who the member can ask something (and get an answer right away): boss, reports and dotted lines, both ways. */
export function colleagues(company: Company, memberId: string): CompanyMember[] {
  const me = company.members.find((m) => m.id === memberId)
  if (!me) return []
  const ids = new Set<string>([...(me.reportsTo ? [me.reportsTo] : []), ...directReports(company, memberId).map((m) => m.id), ...me.collaborates])
  for (const other of company.members) if (other.collaborates.includes(memberId)) ids.add(other.id)
  ids.delete(memberId)
  return company.members.filter((m) => ids.has(m.id))
}

/** Making `memberId` report to `boss` must not create a loop (a boss can't report to someone below them). */
export function canReportTo(company: Company, memberId: string, boss: string | null): boolean {
  if (boss === null) return true
  if (boss === memberId) return false
  return !subordinates(company, memberId).some((m) => m.id === boss)
}

/** The top of the org chart (reports to the board): answers the company's WhatsApp and chairs by default. */
export function head(company: Company): CompanyMember | undefined {
  return company.members.find((m) => m.reportsTo === null) ?? company.members[0]
}

export function depth(company: Company, memberId: string): number {
  return chainOfCommand(company, memberId).length
}

// ---------------------------------------------------------------------------
// Spend (estimated): list prices in USD per million tokens. They change; the board sees "estimado".
// ponytail: one price per provider; per-model prices if budgets need to be exact.
export const PRICES: Record<ProviderId, { input: number; output: number; cacheRead: number }> = {
  anthropic: { input: 5, output: 25, cacheRead: 0.5 },
  xai: { input: 3, output: 15, cacheRead: 0.75 },
  deepseek: { input: 0.3, output: 1.2, cacheRead: 0.03 },
  // The gateway bills each model at its own price; this is a Sonnet-class guess.
  vercel: { input: 3, output: 15, cacheRead: 0.3 },
  // Muse Spark 1.3 (standard); Wonder cuesta más.
  meta: { input: 1.25, output: 4.25, cacheRead: 0.15 }
}

export function costOf(provider: ProviderId, usage: Usage): number {
  const price = PRICES[provider]
  const cached = usage.cacheReadTokens ?? 0
  return ((usage.inputTokens - cached) * price.input + cached * price.cacheRead + usage.outputTokens * price.output) / 1_000_000
}

export const monthKey = (at = new Date()): string => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`

// ---------------------------------------------------------------------------
// Templates

export interface MemberTemplate {
  key: string
  title: string
  /** Template key of the boss; null = reports to the board. */
  reportsTo: string | null
  description: string
  instructions: string
  tools: string[]
  canDelegate: boolean
  autoApprove?: string[]
}

export interface CompanyTemplate {
  id: string
  name: string
  mission: string
  goals: string
  color: string
  members: MemberTemplate[]
}

const OFFICE = ['office_read', 'office_create', 'office_edit']
const FILES = ['read_file', 'list_dir', 'search_files', 'write_file', 'edit_file']

const CEO = (what: string): MemberTemplate => ({
  key: 'ceo',
  title: 'Director/a general',
  reportsTo: null,
  description: `Dirige la empresa: ${what}. Reparte el trabajo, revisa entregas y le reporta al Directorio (el usuario).`,
  instructions: `Sos quien dirige la empresa. Convertís los objetivos en tareas concretas para tu equipo (assign_task), revisás lo que entregan (review_task) y decidís.
Antes de un plan grande o de algo que cueste plata o comprometa a la empresa, pedile el visto bueno al Directorio con escalate.
No hagas vos el trabajo de tu equipo: delegá en quien corresponde y controlá el resultado contra el objetivo.`,
  tools: [...FILES, ...OFFICE],
  canDelegate: true
})

export const COMPANY_TEMPLATES: CompanyTemplate[] = [
  {
    id: 'marketing',
    name: 'Agencia de marketing',
    mission: 'Agencia que crea y publica contenido para redes y campañas por mail, y mide los resultados.',
    goals: 'Publicar 3 posteos por semana en Instagram\nResponder consultas en menos de 24 h\nInforme mensual de métricas',
    color: '#8b5cf6',
    members: [
      CEO('una agencia de marketing'),
      {
        key: 'estratega',
        title: 'Estratega de contenidos',
        reportsTo: 'ceo',
        description: 'Arma el calendario de contenidos, define mensajes y públicos, y briefea al community manager y al redactor.',
        instructions: 'Planificás qué se publica, cuándo y para quién. Investigá tendencias y competencia en la web. Dejá el calendario y los briefs en el vault (Marketing/Calendario.md). Asigná las piezas al community manager y al redactor.',
        tools: [...FILES, ...OFFICE],
        canDelegate: true
      },
      {
        key: 'community',
        title: 'Community manager',
        reportsTo: 'estratega',
        description: 'Crea y publica los posteos de Instagram (imagen + texto) y responde mensajes.',
        instructions: 'Creás posteos para Instagram: una imagen (generate_image o compose_image) y un texto con gancho, cuerpo breve, llamada a la acción y hashtags. Publicás con instagram_publish (se aprueba antes). Registrá cada publicación en Marketing/Publicaciones.md.',
        tools: [...FILES, 'generate_image', 'compose_image', 'instagram_publish'],
        canDelegate: false,
        autoApprove: ['generate_image', 'compose_image', 'write_file', 'edit_file']
      },
      {
        key: 'redactor',
        title: 'Redactor/a',
        reportsTo: 'estratega',
        description: 'Escribe textos: newsletters, mails a clientes, artículos y propuestas.',
        instructions: 'Escribís textos claros en la voz de la marca. Para mails usá email_send (se aprueba antes de salir). Las propuestas y documentos, en Word (office_create) dentro del vault.',
        tools: [...FILES, ...OFFICE],
        canDelegate: false
      },
      {
        key: 'metricas',
        title: 'Analista de métricas',
        reportsTo: 'ceo',
        description: 'Mide resultados (alcance, interacción, ventas), arma tableros en Excel e informes.',
        instructions: 'Trabajás con datos: siempre citá de dónde sale cada número y no inventes valores. Planillas en Excel con fórmulas (no números calculados a mano). Informe mensual en Informes/ del vault.',
        tools: [...FILES, ...OFFICE],
        canDelegate: false
      }
    ]
  },
  {
    id: 'ecommerce',
    name: 'Ecommerce / tienda',
    mission: 'Tienda online: catálogo, precios, ventas, atención al cliente y logística.',
    goals: 'Catálogo y precios al día\nResponder a clientes en el día\nControlar stock semanalmente',
    color: '#10b981',
    members: [
      CEO('una tienda online'),
      {
        key: 'catalogo',
        title: 'Catálogo y precios',
        reportsTo: 'ceo',
        description: 'Mantiene el catálogo de productos y la lista de precios (Excel), compara con la competencia.',
        instructions: 'Llevás Catalogo.xlsx en el vault: producto, costo, precio, margen (con fórmulas), stock. Investigá precios de la competencia en la web y proponé cambios al director antes de aplicarlos.',
        tools: [...FILES, ...OFFICE],
        canDelegate: false
      },
      {
        key: 'marketing',
        title: 'Marketing',
        reportsTo: 'ceo',
        description: 'Promociones, posteos de productos en Instagram y mails a clientes.',
        instructions: 'Armás promociones y posteos de productos (imagen + texto) y campañas por mail. Todo lo que sale hacia afuera se aprueba antes.',
        tools: [...FILES, 'generate_image', 'compose_image', 'instagram_publish'],
        canDelegate: false,
        autoApprove: ['generate_image', 'compose_image']
      },
      {
        key: 'atencion',
        title: 'Atención al cliente',
        reportsTo: 'ceo',
        description: 'Responde consultas por WhatsApp y mail, registra reclamos y pedidos.',
        instructions: 'Respondés con amabilidad y precisión, solo con información verificada del catálogo y las políticas del vault. Registrá cada reclamo en Atencion/Reclamos.md. Lo que no sepas, escalalo.',
        tools: [...FILES, ...OFFICE],
        canDelegate: false
      },
      {
        key: 'logistica',
        title: 'Logística y stock',
        reportsTo: 'ceo',
        description: 'Controla stock, envíos y proveedores.',
        instructions: 'Controlás el stock contra el catálogo, avisás faltantes y armás pedidos a proveedores (borradores en Word/Excel en el vault).',
        tools: [...FILES, ...OFFICE],
        canDelegate: false
      },
      {
        key: 'finanzas',
        title: 'Finanzas',
        reportsTo: 'ceo',
        description: 'Ventas, costos, márgenes y flujo de caja en Excel.',
        instructions: 'Llevás Finanzas.xlsx con fórmulas: ventas, costos, márgenes y caja. Citá siempre la fuente de cada dato y marcá lo estimado.',
        tools: [...FILES, ...OFFICE],
        canDelegate: false
      }
    ]
  },
  {
    id: 'administracion',
    name: 'Administración / estudio',
    mission: 'Estudio que lleva la administración: facturas, pagos, documentos, mails y agenda.',
    goals: 'Facturas cargadas en el día\nVencimientos sin atrasos\nDocumentos ordenados en el vault',
    color: '#0ea5e9',
    members: [
      CEO('un estudio administrativo'),
      {
        key: 'contable',
        title: 'Contable',
        reportsTo: 'ceo',
        description: 'Facturas, pagos y vencimientos: lee PDFs, carga planillas y controla saldos.',
        instructions: 'Leés facturas y comprobantes (PDF), los cargás en Contabilidad.xlsx con fórmulas y controlás vencimientos. Nunca inventes montos: si un dato no está, preguntá.',
        tools: [...FILES, ...OFFICE],
        canDelegate: false
      },
      {
        key: 'administrativo',
        title: 'Administrativo/a',
        reportsTo: 'ceo',
        description: 'Mails, documentos en Word, notas y archivo del vault.',
        instructions: 'Redactás mails (email_send, se aprueban antes) y documentos en Word con el formato del estudio, y mantenés ordenado el vault.',
        tools: [...FILES, ...OFFICE],
        canDelegate: false
      },
      {
        key: 'agenda',
        title: 'Agenda y recordatorios',
        reportsTo: 'ceo',
        description: 'Turnos, vencimientos y recordatorios para el equipo y el Directorio.',
        instructions: 'Llevás la agenda en Agenda.md del vault y programás recordatorios (create_reminder) para vencimientos y reuniones.',
        tools: [...FILES],
        canDelegate: false
      }
    ]
  }
]

/** Agent profile for a position: the template's instructions on top of the company's model choice. */
export function memberAgent(company: Company, member: CompanyMember, template: Pick<MemberTemplate, 'description' | 'instructions' | 'tools' | 'canDelegate' | 'autoApprove'>, name: string): AgentProfile {
  return {
    id: member.id,
    name,
    description: template.description,
    systemPrompt: template.instructions,
    provider: 'meta',
    model: DEFAULT_META_MODEL,
    effort: 'medium',
    tools: template.tools,
    allowMcp: false,
    canDelegate: template.canDelegate,
    autoApproveTools: template.autoApprove,
    companyId: company.id
  }
}

/** First names for new agents, so the org chart reads like a team ("Sofía · Community manager"). */
export const AGENT_NAMES = ['Sofía', 'Martín', 'Lucía', 'Tomás', 'Valentina', 'Joaquín', 'Camila', 'Mateo', 'Julieta', 'Bruno', 'Florencia', 'Nicolás', 'Paula', 'Diego', 'Abril', 'Franco']

export function pickName(taken: string[], offset = 0): string {
  const free = AGENT_NAMES.filter((n) => !taken.includes(n))
  return (free.length ? free : AGENT_NAMES)[offset % (free.length || AGENT_NAMES.length)]
}

export const newId = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 9)}`
