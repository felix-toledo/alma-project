import * as z from 'zod/v4'
import { defineTool, ToolError, truncateMiddle, type ToolContext, type ToolDefinition } from '../tools/types'
import { DRAWING_EXT, describeDrawing, parseDrawing, queueOp } from '../../shared/excalidraw'
import { KNOWLEDGE_DIR, MEMORY_FILE } from './base'

function vault(ctx: ToolContext): NonNullable<ToolContext['knowledge']> {
  if (!ctx.knowledge) throw new ToolError('No hay un vault activo. Pedile al usuario que abra uno en la vista Vault.')
  return ctx.knowledge
}

const searchKnowledgeTool = defineTool({
  name: 'search_knowledge',
  description:
    'Busca en el vault del usuario (sus notas y lo que Alma aprendió) combinando palabras clave y significado. Devuelve fragmentos con ruta y línea. Usalo cuando la pregunta pueda estar respondida en sus notas y el contexto que ya tenés no alcance.',
  risk: 'read',
  standalone: true,
  schema: z.object({
    query: z.string().min(2).describe('Qué buscar, en lenguaje natural o palabras clave'),
    limit: z.number().int().min(1).max(20).optional().describe('Cantidad de resultados (por defecto 8)')
  }),
  async run({ query, limit = 8 }, ctx) {
    const hits = await vault(ctx).search(query, limit)
    if (hits.length === 0) return 'Sin resultados en el vault.'
    return hits
      .map((hit, i) => `[${i + 1}] ${hit.path}:${hit.line}${hit.heading ? ` › ${hit.heading}` : ''}${hit.similarity !== undefined ? ` (similitud ${hit.similarity.toFixed(2)})` : ''}\n${hit.snippet}`)
      .join('\n\n')
  }
})

const readNoteTool = defineTool({
  name: 'read_note',
  description: 'Lee una nota completa del vault por su ruta relativa (por ejemplo la que devolvió search_knowledge).',
  risk: 'read',
  standalone: true,
  schema: z.object({ path: z.string().describe('Ruta relativa dentro del vault, p. ej. "Proyectos/Idea.md"') }),
  async run({ path }, ctx) {
    return truncateMiddle((await vault(ctx).read(path)).content)
  }
})

const saveKnowledgeTool = defineTool({
  name: 'save_knowledge',
  description: `Guarda conocimiento duradero como nota en ${KNOWLEDGE_DIR}/ del vault: conclusiones, investigaciones, decisiones, procedimientos o resúmenes que valga la pena reutilizar. Si ya existe una nota casi igual no se duplica y te dice cuál es; para corregir o ampliar una nota tuya pasá su path con el contenido completo. No lo uses para datos cortos sobre el usuario (eso es remember).`,
  risk: 'memory',
  standalone: true,
  schema: z.object({
    title: z.string().min(3).describe('Título claro y buscable'),
    content: z.string().min(10).describe('Contenido en markdown, autosuficiente (se lee sin esta conversación)'),
    path: z.string().optional().describe(`Solo para actualizar una nota existente de ${KNOWLEDGE_DIR}/`)
  }),
  async run(input, ctx) {
    return (await vault(ctx).saveKnowledge({ ...input, threadId: ctx.threadId })).message
  }
})

const rememberTool = defineTool({
  name: 'remember',
  description: `Recuerda un dato corto y estable sobre el usuario (preferencias, contexto personal o laboral, cómo le gusta trabajar). Se guarda como una línea en ${MEMORY_FILE} y va en todas las conversaciones. Una idea por llamada, en tercera persona y sin datos sensibles que no haya pedido guardar.`,
  risk: 'memory',
  standalone: true,
  schema: z.object({ text: z.string().min(3).max(300).describe('El recuerdo, p. ej. "Prefiere respuestas cortas en español rioplatense"') }),
  async run({ text }, ctx) {
    return vault(ctx).remember(text)
  }
})

const forgetTool = defineTool({
  name: 'forget',
  description: `Borra un recuerdo de ${MEMORY_FILE} cuando quedó desactualizado o el usuario lo pide.`,
  risk: 'memory',
  standalone: true,
  schema: z.object({ text: z.string().min(2).describe('El texto del recuerdo (exacto o una parte única)') }),
  async run({ text }, ctx) {
    return vault(ctx).forget(text)
  }
})

/** Available to every agent whenever a vault is active, like delegate_task. */

const Skeleton = z.object({
  type: z.enum(['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line']),
  id: z.string().optional().describe('Para que las flechas lo referencien'),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  text: z.string().optional().describe('Etiqueta de la figura o flecha, o el contenido si type es text'),
  strokeColor: z.string().optional().describe('Color de línea, p. ej. "#1e1e1e"'),
  backgroundColor: z.string().optional().describe('Relleno, p. ej. "#a5d8ff"'),
  start: z.string().optional().describe('Flechas: id de la figura donde empieza'),
  end: z.string().optional().describe('Flechas: id de la figura donde termina')
})

const drawingPath = (path: string): string => (DRAWING_EXT.test(path) ? path : `${path.replace(/\.md$/i, '')}.excalidraw`)

const excalidrawReadTool = defineTool({
  name: 'excalidraw_read',
  description:
    'Lee un dibujo de Excalidraw del vault (.excalidraw) como lista de elementos: id, tipo, texto, posición y qué conecta cada flecha. Usalo antes de modificar un dibujo.',
  risk: 'read',
  standalone: true,
  schema: z.object({ path: z.string().describe('Ruta del dibujo en el vault, p. ej. "Dibujos/Proceso.excalidraw"') }),
  async run({ path }, ctx) {
    const drawing = parseDrawing((await vault(ctx).read(drawingPath(path))).content)
    const pending = drawing.alma?.ops.length ? `\n(Hay ${drawing.alma.ops.length} cambio(s) tuyos pendientes que se aplican cuando el usuario abre el dibujo.)` : ''
    return `Dibujo ${drawingPath(path)}:\n${describeDrawing(drawing.elements)}${pending}`
  }
})

const excalidrawDrawTool = defineTool({
  name: 'excalidraw_draw',
  description: `Crea o modifica un dibujo de Excalidraw en el vault del usuario (lo ve y lo edita a mano en la vista Vault; también se puede insertar en una nota con ![[Nombre.excalidraw]]).
Dos formas de dibujar (podés combinarlas):
- mermaid: un diagrama Mermaid (flowchart, sequenceDiagram, classDiagram) que se acomoda solo. Lo mejor para procesos, flujos y mapas de lo que hablaron.
- elements: figuras sueltas con posición: rectangle/ellipse/diamond con text como etiqueta, text suelto, y arrow con start/end = ids de figuras. Coordenadas en píxeles, x hacia la derecha e y hacia abajo; dejá ~80 px entre figuras.
Para cambiar un dibujo existente: leelo con excalidraw_read, borrá con delete (ids) y agregá lo nuevo; las flechas nuevas pueden conectarse a ids que ya existen. replace=true lo rehace desde cero.`,
  risk: 'memory',
  standalone: true,
  schema: z.object({
    path: z.string().describe('Ruta del dibujo, p. ej. "Dibujos/Plan de la semana.excalidraw" (se crea si no existe)'),
    mermaid: z.string().optional(),
    elements: z.array(Skeleton).optional(),
    delete: z.array(z.string()).optional().describe('ids de elementos a borrar'),
    replace: z.boolean().optional().describe('Borrar todo lo que había antes')
  }),
  async run({ path, mermaid, elements, delete: remove, replace }, ctx) {
    if (!mermaid && !elements?.length && !remove?.length && !replace) throw new ToolError('Pasá mermaid, elements o delete.')
    const target = drawingPath(path)
    const current = await vault(ctx).read(target).then((file) => file.content, () => '')
    await vault(ctx).write(target, queueOp(current, { mermaid, elements, delete: remove, replace }))
    return `Listo: ${target}. Se termina de dibujar cuando el usuario lo abre en el vault (o lo ve insertado en una nota).`
  }
})

export const knowledgeTools: ToolDefinition[] = [searchKnowledgeTool, readNoteTool, saveKnowledgeTool, rememberTool, forgetTool, excalidrawReadTool, excalidrawDrawTool]
export const knowledgeToolsByName = new Map(knowledgeTools.map((tool) => [tool.name, tool]))
