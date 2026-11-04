import * as z from 'zod/v4'
import { defineTool, ToolError, toolText, truncateMiddle, type ToolContext, type ToolDefinition } from '../tools/types'
import { DRAWING_EXT, describeDrawing, parseDrawing, queueOp } from '../../shared/excalidraw'
import { KNOWLEDGE_DIRS, MEMORY_FILES } from './base'

// The vault uses one of the two names (Alma writes in the app language, but a vault that already has the other keeps it).
const KNOWLEDGE_FOLDER = `${KNOWLEDGE_DIRS.en}/ (${KNOWLEDGE_DIRS.es}/ in a vault that already uses it)`
const MEMORY_FILE = `${MEMORY_FILES.en} (${MEMORY_FILES.es} in a vault that already uses it)`

function vault(ctx: ToolContext): NonNullable<ToolContext['knowledge']> {
  if (!ctx.knowledge) throw new ToolError('tool.kb.noVault')
  return ctx.knowledge
}

const searchKnowledgeTool = defineTool({
  name: 'search_knowledge',
  description:
    'Searches the user\'s vault (their notes and what Alma learned) combining keywords and meaning. Returns fragments with path and line. Use it when the question may be answered in their notes and the context you already have is not enough.',
  risk: 'read',
  standalone: true,
  schema: z.object({
    query: z.string().min(2).describe('What to look for, in natural language or keywords'),
    limit: z.number().int().min(1).max(20).optional().describe('Number of results (default 8)')
  }),
  async run({ query, limit = 8 }, ctx) {
    const hits = await vault(ctx).search(query, limit)
    if (hits.length === 0) return toolText(ctx, 'tool.kb.noHits')
    return hits
      .map((hit, i) => `[${i + 1}] ${hit.path}:${hit.line}${hit.heading ? ` › ${hit.heading}` : ''}${hit.similarity !== undefined ? ` (similarity ${hit.similarity.toFixed(2)})` : ''}\n${hit.snippet}`)
      .join('\n\n')
  }
})

const readNoteTool = defineTool({
  name: 'read_note',
  description: 'Reads a whole note from the vault by its relative path (for example the one search_knowledge returned).',
  risk: 'read',
  standalone: true,
  schema: z.object({ path: z.string().describe('Relative path inside the vault, e.g. "Projects/Idea.md"') }),
  async run({ path }, ctx) {
    return truncateMiddle((await vault(ctx).read(path)).content)
  }
})

const saveKnowledgeTool = defineTool({
  name: 'save_knowledge',
  description: `Saves lasting knowledge as a note in ${KNOWLEDGE_FOLDER} of the vault: conclusions, research, decisions, procedures or summaries worth reusing. If a nearly identical note already exists it is not duplicated and you are told which one it is; to correct or extend a note of yours pass its path with the full content. Do not use it for short facts about the user (that is remember).`,
  risk: 'memory',
  standalone: true,
  schema: z.object({
    title: z.string().min(3).describe('Clear, searchable title'),
    content: z.string().min(10).describe('Markdown content, self-sufficient (read without this conversation)'),
    path: z.string().optional().describe(`Only to update an existing note in the knowledge folder`)
  }),
  async run(input, ctx) {
    return (await vault(ctx).saveKnowledge({ ...input, threadId: ctx.threadId }, ctx)).message
  }
})

const rememberTool = defineTool({
  name: 'remember',
  description: `Remembers a short, stable fact about the user (preferences, personal or work context, how they like to work). It is saved as a line in ${MEMORY_FILE} and goes into every conversation. One idea per call, in third person and without sensitive data they did not ask to save.`,
  risk: 'memory',
  standalone: true,
  schema: z.object({ text: z.string().min(3).max(300).describe('The memory, e.g. "Prefers short answers"') }),
  async run({ text }, ctx) {
    return vault(ctx).remember(text, ctx)
  }
})

const forgetTool = defineTool({
  name: 'forget',
  description: `Deletes a memory from ${MEMORY_FILE} when it became outdated or the user asks.`,
  risk: 'memory',
  standalone: true,
  schema: z.object({ text: z.string().min(2).describe('The memory text (exact, or a unique part)') }),
  async run({ text }, ctx) {
    return vault(ctx).forget(text, ctx)
  }
})

/** Available to every agent whenever a vault is active, like delegate_task. */

const Skeleton = z.object({
  type: z.enum(['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line']),
  id: z.string().optional().describe('So arrows can reference it'),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  text: z.string().optional().describe('Label of the shape or arrow, or the content if type is text'),
  strokeColor: z.string().optional().describe('Line color, e.g. "#1e1e1e"'),
  backgroundColor: z.string().optional().describe('Fill, e.g. "#a5d8ff"'),
  start: z.string().optional().describe('Arrows: id of the shape where it starts'),
  end: z.string().optional().describe('Arrows: id of the shape where it ends')
})

const drawingPath = (path: string): string => (DRAWING_EXT.test(path) ? path : `${path.replace(/\.md$/i, '')}.excalidraw`)

const excalidrawReadTool = defineTool({
  name: 'excalidraw_read',
  description:
    'Reads an Excalidraw drawing from the vault (.excalidraw) as a list of elements: id, type, text, position and what each arrow connects. Use it before modifying a drawing.',
  risk: 'read',
  standalone: true,
  schema: z.object({ path: z.string().describe('Path of the drawing in the vault, e.g. "Drawings/Process.excalidraw"') }),
  async run({ path }, ctx) {
    const drawing = parseDrawing((await vault(ctx).read(drawingPath(path))).content)
    const data = describeDrawing(drawing.elements)
    const count = drawing.alma?.ops.length ?? 0
    return count ? toolText(ctx, 'tool.kb.drawingPending', { path: drawingPath(path), data, count }) : toolText(ctx, 'tool.kb.drawing', { path: drawingPath(path), data })
  }
})

const excalidrawDrawTool = defineTool({
  name: 'excalidraw_draw',
  description: `Creates or modifies an Excalidraw drawing in the user's vault (they see and edit it by hand in the Vault view; it can also be embedded in a note with ![[Name.excalidraw]]).
Two ways to draw (you can combine them):
- mermaid: a Mermaid diagram (flowchart, sequenceDiagram, classDiagram) that lays itself out. Best for processes, flows and maps of what was discussed.
- elements: loose shapes with position: rectangle/ellipse/diamond with text as label, loose text, and arrow with start/end = shape ids. Coordinates in pixels, x to the right and y down; leave ~80 px between shapes.
To change an existing drawing: read it with excalidraw_read, delete with delete (ids) and add the new; new arrows can connect to ids that already exist. replace=true redoes it from scratch.`,
  risk: 'memory',
  standalone: true,
  schema: z.object({
    path: z.string().describe('Path of the drawing, e.g. "Drawings/Weekly plan.excalidraw" (created if it does not exist)'),
    mermaid: z.string().optional(),
    elements: z.array(Skeleton).optional(),
    delete: z.array(z.string()).optional().describe('ids of elements to delete'),
    replace: z.boolean().optional().describe('Delete everything that was there before')
  }),
  async run({ path, mermaid, elements, delete: remove, replace }, ctx) {
    if (!mermaid && !elements?.length && !remove?.length && !replace) throw new ToolError('tool.kb.drawNothing')
    const target = drawingPath(path)
    const current = await vault(ctx).read(target).then((file) => file.content, () => '')
    await vault(ctx).write(target, queueOp(current, { mermaid, elements, delete: remove, replace }))
    return toolText(ctx, 'tool.kb.drawn', { path: target })
  }
})

export const knowledgeTools: ToolDefinition[] = [searchKnowledgeTool, readNoteTool, saveKnowledgeTool, rememberTool, forgetTool, excalidrawReadTool, excalidrawDrawTool]
export const knowledgeToolsByName = new Map(knowledgeTools.map((tool) => [tool.name, tool]))
