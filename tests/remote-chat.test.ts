import { describe, expect, it, vi } from 'vitest'
import type { RemoteResponse } from '../src/shared/remote/api.js'
import type { ChatMessage } from '../src/shared/types.js'
import { HOST, openSession, pairDevice, testChannel, type Harness } from './support/remote-harness.js'

interface StateBody {
  rev: number
  running: boolean
  messages: { index: number; role: string; text: string; at: number }[]
}

function body(res: RemoteResponse): StateBody {
  return res.body as StateBody
}

function textMsg(role: 'user' | 'assistant', text: string, ts = 1000): ChatMessage {
  return { role, content: [{ type: 'text', text }], ts }
}

async function served(): Promise<{ t: Harness; headers: Record<string, string> }> {
  const t = await testChannel({
    remote: {
      enabled: true,
      scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false }
    }
  })
  await t.channel.sync()
  const { deviceId, privateKey } = await pairDevice(t)
  const token = await openSession(t, deviceId, privateKey)
  return { t, headers: { ...HOST, authorization: `Bearer ${token}` } }
}

describe('T20 chat + thread remoto (AC-5.5, AC-5.16, AC-5.17, AC-8.4, PD-12)', () => {
  it('AC-5.5: send <= 8000 corre el agente configurado sobre el thread remoto compartido (200)', async () => {
    const { t, headers } = await served()
    const res = await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'hola' } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(t.chat.askCalls).toEqual([{ threadId: 'remote', text: 'hola' }])
  })

  it('AC-5.5: la respuesta del agente vuelve al teléfono vía /api/state', async () => {
    const { t, headers } = await served()
    await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'hola' } })
    t.chat.resolveAsk(0, 'hola, ¿qué tal?')
    await t.chat.pending[0]?.promise
    const state = await t.transport.request({ method: 'GET', path: '/api/state', headers })
    expect(state.status).toBe(200)
    expect(body(state).messages.at(-1)).toEqual({
      index: 1,
      role: 'assistant',
      text: 'hola, ¿qué tal?',
      at: expect.any(Number)
    })
    expect(body(state).running).toBe(false)
  })

  it('AC-5.5: un run que falla de forma sincrónica da 500 failed (la PWA muestra chan.failed)', async () => {
    const { t, headers } = await served()
    t.chat.throwSync = true
    const res = await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'hola' } })
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'failed' })
  })

  it('AC-5.5: un run que falla async se ve en state (sin respuesta nueva, sin correr)', async () => {
    const { t, headers } = await served()
    await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'hola' } })
    t.chat.rejectAsk(0, new Error('boom'))
    await t.chat.pending[0]?.promise.catch(() => {})
    const state = await t.transport.request({ method: 'GET', path: '/api/state', headers })
    expect(body(state).running).toBe(false)
    expect(body(state).messages).toHaveLength(1)
    expect(body(state).messages[0].role).toBe('user')
  })

  it('T20: un send con un run en curso da 409 busy (la PWA muestra chan.failed)', async () => {
    const { t, headers } = await served()
    await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'uno' } })
    const res = await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'dos' } })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'busy' })
    expect(t.chat.askCalls).toHaveLength(1)
  })

  it('AC-5.5/10.1: un mensaje de 8001 caracteres se refusa con 400 (la PWA muestra remote.pwa.tooLong)', async () => {
    const { t, headers } = await served()
    const ok = await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'x'.repeat(8000) } })
    expect(ok.status).toBe(200)
    t.chat.resolveAsk(0, 'ok')
    await t.chat.pending[0]?.promise
    const res = await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'y'.repeat(8001) } })
    expect(res.status).toBe(400)
    expect(t.chat.askCalls).toHaveLength(1)
  })

  it('AC-5.24: chat/new crea un thread remoto nuevo y conserva el anterior', async () => {
    const { t, headers } = await served()
    await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'viejo' } })
    t.chat.resolveAsk(0, 'r')
    await t.chat.pending[0]?.promise
    const res = await t.transport.request({ method: 'POST', path: '/api/chat/new', headers, body: {} })
    expect(res.status).toBe(200)
    const state = await t.transport.request({ method: 'GET', path: '/api/state', headers })
    expect(body(state).rev).toBe(0)
    expect(body(state).messages).toEqual([])
    expect(t.chat.threads).toHaveLength(2)
    expect(t.chat.threads[0]?.messages).toHaveLength(2)
  })

  it('AC-5.16: chat/stop cancela el run actual con el id del thread remoto y niega approvals', async () => {
    const { t, headers } = await served()
    await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'hola' } })
    const res = await t.transport.request({ method: 'POST', path: '/api/chat/stop', headers, body: {} })
    expect(res.status).toBe(200)
    expect(t.chat.cancelCalls).toEqual(['remote'])
    expect(t.chat.approvals.every((a) => a.denied)).toBe(true)
    await t.chat.pending[0]?.promise.catch(() => {})
    const state = await t.transport.request({ method: 'GET', path: '/api/state', headers })
    expect(body(state).running).toBe(false)
  })

  it.each(['desktop-1', 'other-remote-thread', 'company-thread'])(
    'AC-5.17: chat/send con thread %s se refusa con 400 (solo existe el remoto)',
    async (thread) => {
      const { t, headers } = await served()
      const res = await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'hola', thread } })
      expect(res.status).toBe(400)
      expect(t.chat.askCalls).toHaveLength(0)
    }
  )

  it.each(['/api/chat/new', '/api/chat/stop'])(
    'AC-5.17: %s con clave thread se refusa con 400',
    async (path) => {
      const { t, headers } = await served()
      const res = await t.transport.request({ method: 'POST', path, headers, body: { thread: 'desktop-1' } })
      expect(res.status).toBe(400)
    }
  )

  it('PD-12: la primera carga trae los últimos 30 mensajes con índices absolutos', async () => {
    const { t, headers } = await served()
    for (let i = 0; i < 31; i++) t.chat.seed([textMsg('user', `m${i}`, 1000 + i)])
    const state = await t.transport.request({ method: 'GET', path: '/api/state', headers })
    expect(body(state).rev).toBe(31)
    expect(body(state).messages).toHaveLength(30)
    expect(body(state).messages[0]).toMatchObject({ index: 1, text: 'm1' })
    expect(body(state).messages.at(-1)).toMatchObject({ index: 30, text: 'm30' })
  })

  it('PD-12: con since solo llegan los más nuevos', async () => {
    const { t, headers } = await served()
    for (let i = 0; i < 31; i++) t.chat.seed([textMsg('user', `m${i}`, 1000 + i)])
    const state = await t.transport.request({ method: 'GET', path: '/api/state', query: 'since=30', headers })
    expect(body(state).rev).toBe(31)
    expect(body(state).messages).toEqual([{ index: 30, role: 'user', text: 'm30', at: 1030 }])
  })

  it('T20: /api/state sin scope chat no trae mensajes (el handler filtra por scope)', async () => {
    const t = await testChannel({
      remote: { enabled: true, scopes: { chat: false, approve: true, home: false, cameras: false, vault: false, history: false } }
    })
    await t.channel.sync()
    t.chat.seed([textMsg('user', 'secreto', 1000)])
    const { deviceId, privateKey } = await pairDevice(t)
    const token = await openSession(t, deviceId, privateKey)
    const headers = { ...HOST, authorization: `Bearer ${token}` }
    const state = await t.transport.request({ method: 'GET', path: '/api/state', headers })
    expect(state.status).toBe(200)
    expect(body(state).messages).toEqual([])
    expect(body(state).rev).toBe(1)
  })

  it('PD-12: tool-use, tool-result y thinking se quitan; sin texto el mensaje se omite', async () => {
    const { t, headers } = await served()
    t.chat.seed([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'listo' },
          { type: 'tool_use', id: 't1', name: 'run_command', input: { cmd: 'ls' } },
          { type: 'tool_result', tool_use_id: 't1', content: 'secreto' },
          { type: 'thinking', thinking: 'pensando' }
        ],
        ts: 1000
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't2', name: 'hidden_tool', input: {} }],
        ts: 1001
      }
    ])
    const state = await t.transport.request({ method: 'GET', path: '/api/state', headers })
    expect(body(state).messages).toEqual([{ index: 0, role: 'assistant', text: 'listo', at: 1000 }])
    const raw = JSON.stringify(state.body)
    expect(raw).not.toContain('run_command')
    expect(raw).not.toContain('hidden_tool')
    expect(raw).not.toContain('secreto')
    expect(raw).not.toContain('pensando')
  })

  it('PD-12: si los 30 no entran en 1 MB, los más viejos se sueltan hasta que entren', async () => {
    const { t, headers } = await served()
    for (let i = 0; i < 30; i++) t.chat.seed([textMsg('user', `m${i}-` + 'x'.repeat(50_000), 1000 + i)])
    const state = await t.transport.request({ method: 'GET', path: '/api/state', headers })
    expect(Buffer.byteLength(JSON.stringify(state.body), 'utf8')).toBeLessThanOrEqual(1024 * 1024)
    expect(body(state).messages.length).toBeLessThan(30)
    expect(body(state).messages[0]?.index).toBeGreaterThan(0)
    expect(body(state).messages.at(-1)?.index).toBe(29)
  })

  it('PD-12: un solo mensaje mayor al tope se corta para que entre', async () => {
    const { t, headers } = await served()
    t.chat.seed([textMsg('user', 'y'.repeat(2 * 1024 * 1024), 1000)])
    const state = await t.transport.request({ method: 'GET', path: '/api/state', headers })
    expect(Buffer.byteLength(JSON.stringify(state.body), 'utf8')).toBeLessThanOrEqual(1024 * 1024)
    expect(body(state).messages).toHaveLength(1)
    expect(body(state).messages[0].text.length).toBeLessThan(2 * 1024 * 1024)
  })

  it('AC-1.7: un long-poll retenido vuelve cuando llega un mensaje nuevo', async () => {
    const { t, headers } = await served()
    t.chat.seed([textMsg('user', 'viejo', 1000)])
    const pending = t.transport.request({ method: 'GET', path: '/api/state', query: 'since=1', headers })
    const send = await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'nuevo' } })
    expect(send.status).toBe(200)
    const state = await pending
    expect(body(state).rev).toBe(2)
    expect(body(state).messages).toEqual([{ index: 1, role: 'user', text: 'nuevo', at: expect.any(Number) }])
  })

  it('AC-1.7: un long-poll sin cambios vuelve a los 25s con lo actual', async () => {
    vi.useFakeTimers()
    try {
      const { t, headers } = await served()
      t.chat.seed([textMsg('user', 'viejo', 1000)])
      const pending = t.transport.request({ method: 'GET', path: '/api/state', query: 'since=1', headers })
      await vi.advanceTimersByTimeAsync(25_000)
      const state = await pending
      expect(body(state).rev).toBe(1)
      expect(body(state).messages).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('AC-8.4: si la conexión cae, al volver solo hay commits (nunca un borrador)', async () => {
    const { t, headers } = await served()
    await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'hola' } })
    const mid = await t.transport.request({ method: 'GET', path: '/api/state', headers })
    expect(body(mid).running).toBe(true)
    expect(body(mid).messages).toEqual([{ index: 0, role: 'user', text: 'hola', at: expect.any(Number) }])
    t.chat.resolveAsk(0, 'respuesta')
    await t.chat.pending[0]?.promise
    const after = await t.transport.request({ method: 'GET', path: '/api/state', headers })
    expect(body(after).running).toBe(false)
    expect(body(after).messages).toHaveLength(2)
  })

  it('AC-1.7: stop suelta los long-polls retenidos sin colgar', async () => {
    const { t, headers } = await served()
    const pending = t.transport.request({ method: 'GET', path: '/api/state', query: 'since=0', headers })
    await t.channel.stop()
    const state = await pending
    expect(body(state).rev).toBe(0)
  })
})
