// Minimal stdio MCP server used by tests: exposes `echo` and `fail`.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'echo', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Devuelve el texto recibido',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    },
    { name: 'fail', description: 'Siempre falla', inputSchema: { type: 'object', properties: {} } }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'echo') {
    return { content: [{ type: 'text', text: `eco: ${request.params.arguments?.text}` }] }
  }
  return { content: [{ type: 'text', text: 'falló a propósito' }], isError: true }
})

await server.connect(new StdioServerTransport())
