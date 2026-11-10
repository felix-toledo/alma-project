import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pickImageModel } from '../src/shared/images/models'
import { generateImageTool, instagramPublishTool } from '../src/coordinator/tools/media'
import type { HostRequest } from '../src/shared/types'
import { defaultSettings } from '../src/shared/defaults'

// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

let server: Server
let baseUrl: string
const requests: { url: string; body: Record<string, unknown> }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url?.endsWith('/models')) {
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'grok-4' }, { id: 'grok-imagine-image' }, { id: 'grok-2-image' }] }))
        return
      }
      requests.push({ url: req.url ?? '', body: JSON.parse(raw) })
      res.end(JSON.stringify({ created: 0, data: [{ b64_json: PNG.toString('base64') }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${address.port}/v1`
})
afterAll(() => server.close())

let workspace: string
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'alma-media-'))
  requests.length = 0
})
afterEach(() => rmSync(workspace, { recursive: true, force: true }))

function context(hostResult = { ok: true, message: 'Publicado en Instagram.' }) {
  const settings = defaultSettings()
  settings.providers.xai = { apiKey: 'test', baseUrl }
  settings.images = { ...settings.images, provider: 'xai', model: '' } // the tests talk to a local xAI-shaped server
  const hostRequests: HostRequest[] = []
  return {
    hostRequests,
    ctx: {
      workspace,
      signal: new AbortController().signal,
      settings,
      host: {
        request: async (request: HostRequest) => {
          hostRequests.push(request)
          return hostResult
        }
      }
    }
  }
}

describe('generate_image', () => {
  it('picks the newest image model and saves the image in the workspace', async () => {
    const { ctx } = context()
    const out = await generateImageTool.run({ prompt: 'Una taza de café al amanecer, luz cálida', aspect_ratio: '4:5', filename: 'Café de mañana' }, ctx)
    const path = /^Image saved: (.+)$/m.exec(out)![1]
    expect(path).toMatch(/^imagenes\/cafe-de-manana-\d{8}-\d{6}\.png$/)
    expect(readFileSync(join(workspace, path))).toEqual(PNG)
    expect(requests[0].url).toBe('/v1/images/generations')
    expect(requests[0].body).toMatchObject({ model: 'grok-imagine-image', response_format: 'b64_json', n: 1 })
    expect(String(requests[0].body.prompt)).toContain('4:5')
  })

  it('explains a missing key', async () => {
    const { ctx } = context()
    ctx.settings.providers.xai.apiKey = ''
    const previous = process.env.XAI_API_KEY
    delete process.env.XAI_API_KEY
    await expect(generateImageTool.run({ prompt: 'una imagen cualquiera de prueba' }, ctx)).rejects.toThrow(/xAI API key/)
    if (previous) process.env.XAI_API_KEY = previous
  })

  it('chooses image models per provider', () => {
    expect(pickImageModel('xai', ['grok-4', 'grok-2-image', 'grok-imagine-image', 'grok-imagine-video'])).toBe('grok-imagine-image')
    expect(pickImageModel('openai', ['gpt-4o', 'dall-e-3', 'gpt-image-1', 'gpt-image-1.5'])).toBe('gpt-image-1.5')
    expect(pickImageModel('meta', ['muse-spark-1.3', 'muse-image-1.0', 'sam-3.1'])).toBe('muse-image-1.0')
  })
})

describe('instagram_publish', () => {
  it('previews the post and hands it to the host', async () => {
    const { ctx, hostRequests } = context()
    writeFileSync(join(workspace, 'post.png'), PNG)
    const preview = await instagramPublishTool.preview!({ image_path: 'post.png', caption: 'Hola #cafe' }, ctx)
    expect(preview?.imageDataUrl).toMatch(/^data:image\/png;base64,/)
    expect(preview?.note).toMatch(/Modo de prueba/)
    expect(await instagramPublishTool.run({ image_path: 'post.png', caption: 'Hola #cafe' }, ctx)).toBe('Publicado en Instagram.')
    expect(hostRequests).toEqual([{ action: 'instagram.publish', imagePath: join(workspace, 'post.png'), caption: 'Hola #cafe', testMode: true }])
  })

  it('rejects missing images, unsupported formats and too many hashtags', async () => {
    const { ctx, hostRequests } = context()
    writeFileSync(join(workspace, 'post.gif'), 'GIF89a')
    writeFileSync(join(workspace, 'ok.jpg'), PNG)
    await expect(instagramPublishTool.run({ image_path: 'nada.png', caption: 'x' }, ctx)).rejects.toThrow(/does not exist/)
    await expect(instagramPublishTool.run({ image_path: 'post.gif', caption: 'x' }, ctx)).rejects.toThrow(/PNG or JPEG/)
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ')
    await expect(instagramPublishTool.run({ image_path: 'ok.jpg', caption: tags }, ctx)).rejects.toThrow(/30 hashtags/)
    expect(hostRequests).toHaveLength(0)
  })

  it('reports the host failure to the model', async () => {
    const { ctx } = context({ ok: false, message: 'No hay una sesión de Instagram.' })
    writeFileSync(join(workspace, 'post.png'), PNG)
    await expect(instagramPublishTool.run({ image_path: 'post.png', caption: 'x' }, ctx)).rejects.toThrow('No hay una sesión de Instagram.')
  })
})
