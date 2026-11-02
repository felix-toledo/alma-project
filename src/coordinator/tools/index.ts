import { editFileTool, listDirTool, readFileTool, searchFilesTool, writeFileTool } from './fs'
import { composeImageTool, generateImageTool, instagramPublishTool } from './media'
import { officeTools } from './office'
import { runCommandTool } from './shell'
import type { ToolDefinition } from './types'

export const builtinTools: ToolDefinition[] = [
  readFileTool,
  listDirTool,
  searchFilesTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  generateImageTool,
  composeImageTool,
  instagramPublishTool,
  ...officeTools
]

export const builtinToolsByName = new Map(builtinTools.map((tool) => [tool.name, tool]))
