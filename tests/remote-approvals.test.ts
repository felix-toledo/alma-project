import { describe, expect, it } from 'vitest'
import type { RemoteResponse } from '../src/shared/remote/api.js'
import type { ApprovalView, PendingApproval, RemoteSettings } from '../src/shared/types.js'
import { HOST, openSession, pairDevice, testChannel, type Harness } from './support/remote-harness.js'

interface ApprovalsBody {
  approvals: ApprovalView[]
}

interface StateBody {
  rev: number
  running: boolean
  messages: unknown[]
  approvals: ApprovalView[]
}

function body(res: RemoteResponse): ApprovalsBody & StateBody {
  return res.body as ApprovalsBody & StateBody
}

/**
 * Lets in-flight requests reach the flow: session resolution is microtasks-only
 * (the stores write synchronously), so draining the queue registers held polls
 * before the test fires the event that must wake them.
 */
async function held(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

type Scopes = RemoteSettings['scopes']
const ALL: Scopes = { chat: true, approve: true, home: false, cameras: false, vault: false, history: false }

async function served(scopes: Scopes = ALL): Promise<{ t: Harness; headers: Record<string, string> }> {
  const t = await testChannel({ remote: { enabled: true, scopes } })
  await t.channel.sync()
  const { deviceId, privateKey } = await pairDevice(t)
  const token = await openSession(t, deviceId, privateKey)
  return { t, headers: { ...HOST, authorization: `Bearer ${token}` } }
}

function approval(threadId: string, overrides?: Partial<PendingApproval>): Omit<PendingApproval, 'approvalId'> {
  return {
    threadId,
    toolUseId: 'tu1',
    toolName: 'run_command',
    input: { command: 'ls' },
    flagged: false,
    reason: 'list files',
    allowAlways: true,
    ...overrides
  }
}

describe('T21 approvals (AC-5.6 a 5.9, 5.25, 8.3, BR-12)', () => {
  it('AC-5.6: solo se listan los approvals del thread remoto, con lo que muestra Telegram', async () => {
    const { t, headers } = await served()
    const mine = t.approvals.askApproval(approval('remote'))
    t.approvals.askApproval(approval('desktop-1', { toolName: 'other_tool' }))
    const res = await t.transport.request({ method: 'GET', path: '/api/approvals', headers })
    expect(res.status).toBe(200)
    expect(body(res).approvals).toEqual([
      {
        id: mine.approvalId,
        tool: 'run_command',
        input: JSON.stringify({ command: 'ls' }, null, 1),
        flagged: false,
        reason: 'list files',
        question: 'chan.allowQuestion'
      }
    ])
    const raw = JSON.stringify(body(res))
    expect(raw).not.toContain('other_tool')
    expect(raw).not.toContain('desktop-1')
  })

  it('AC-5.6: responder el id de otro thread se refusa igual que un desconocido (409)', async () => {
    const { t, headers } = await served()
    const other = t.approvals.askApproval(approval('desktop-1'))
    const res = await t.transport.request({
      method: 'POST',
      path: '/api/approvals/answer',
      headers,
      body: { id: other.approvalId, decision: 'allow' }
    })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'already-answered' })
    // The other thread's approval stays pending: the answer did not touch it.
    expect(t.approvals.broker.pending()).toHaveLength(1)
    expect(t.approvals.answered).toEqual([])
  })

  it('AC-5.6: allow y deny llegan al broker existente', async () => {
    const { t, headers } = await served()
    const first = t.approvals.askApproval(approval('remote'))
    const second = t.approvals.askApproval(approval('remote', { toolUseId: 'tu2' }))
    const allow = await t.transport.request({
      method: 'POST',
      path: '/api/approvals/answer',
      headers,
      body: { id: first.approvalId, decision: 'allow' }
    })
    expect(allow.status).toBe(200)
    const deny = await t.transport.request({
      method: 'POST',
      path: '/api/approvals/answer',
      headers,
      body: { id: second.approvalId, decision: 'deny' }
    })
    expect(deny.status).toBe(200)
    await expect(first.decision).resolves.toBe('allow')
    await expect(second.decision).resolves.toBe('deny')
    expect(t.approvals.broker.pending()).toEqual([])
  })

  it('AC-5.6: la entrada se corta a 1500 caracteres', async () => {
    const { t, headers } = await served()
    t.approvals.askApproval(approval('remote', { input: { command: 'x'.repeat(3000) } }))
    const res = await t.transport.request({ method: 'GET', path: '/api/approvals', headers })
    const [view] = body(res).approvals
    expect(view?.input.length).toBe(1501)
    expect(view?.input.endsWith('…')).toBe(true)
  })

  it('AC-5.6: un approval flagged muestra la pregunta de flagged', async () => {
    const { t, headers } = await served()
    t.approvals.askApproval(approval('remote', { flagged: true, reason: 'peligroso' }))
    const res = await t.transport.request({ method: 'GET', path: '/api/approvals', headers })
    expect(body(res).approvals[0]).toMatchObject({ flagged: true, reason: 'peligroso', question: 'chan.flagged' })
  })

  it('AC-5.7: ya respondido en el PC → 409 already-answered y nada corre dos veces', async () => {
    const { t, headers } = await served()
    const mine = t.approvals.askApproval(approval('remote'))
    t.approvals.broker.respond(mine.approvalId, 'deny')
    await expect(mine.decision).resolves.toBe('deny')
    const res = await t.transport.request({
      method: 'POST',
      path: '/api/approvals/answer',
      headers,
      body: { id: mine.approvalId, decision: 'allow' }
    })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'already-answered' })
    // First answer wins: the broker never got the phone's.
    expect(t.approvals.answered).toEqual([])
  })

  it('AC-5.7: un id desconocido da 409 already-answered', async () => {
    const { t, headers } = await served()
    const res = await t.transport.request({
      method: 'POST',
      path: '/api/approvals/answer',
      headers,
      body: { id: 'no-existe', decision: 'allow' }
    })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'already-answered' })
    expect(t.approvals.answered).toEqual([])
  })

  it('AC-5.8: el esquema no tiene always y la tarjeta nunca lo ofrece (ni en publish)', async () => {
    const { t, headers } = await served()
    const pub = t.approvals.askApproval(approval('remote', { toolName: 'announce_post', allowAlways: false }))
    const rejected = await t.transport.request({
      method: 'POST',
      path: '/api/approvals/answer',
      headers,
      body: { id: pub.approvalId, decision: 'always' }
    })
    expect(rejected.status).toBe(400)
    const res = await t.transport.request({ method: 'GET', path: '/api/approvals', headers })
    expect(Object.keys(body(res).approvals[0] ?? {}).sort()).toEqual(
      ['flagged', 'id', 'input', 'question', 'reason', 'tool']
    )
    expect(JSON.stringify(body(res))).not.toContain('always')
    // BR-12/OQ-6: publish is answered (once), allow or deny only.
    const allow = await t.transport.request({
      method: 'POST',
      path: '/api/approvals/answer',
      headers,
      body: { id: pub.approvalId, decision: 'allow' }
    })
    expect(allow.status).toBe(200)
    await expect(pub.decision).resolves.toBe('allow')
  })

  it('AC-5.9: con approve apagado no se ven ni se responden, y siguen pendientes', async () => {
    const { t, headers } = await served({ chat: true, approve: false, home: false, cameras: false, vault: false, history: false })
    const mine = t.approvals.askApproval(approval('remote'))
    const list = await t.transport.request({ method: 'GET', path: '/api/approvals', headers })
    expect(list.status).toBe(403)
    const answer = await t.transport.request({
      method: 'POST',
      path: '/api/approvals/answer',
      headers,
      body: { id: mine.approvalId, decision: 'allow' }
    })
    expect(answer.status).toBe(403)
    const state = await t.transport.request({ method: 'GET', path: '/api/state', headers })
    expect(body(state).approvals).toEqual([])
    expect(t.approvals.broker.pending()).toHaveLength(1)
    expect(t.approvals.answered).toEqual([])
  })

  it('AC-5.25: con un thread nuevo, los approvals del anterior no se ven ni se responden', async () => {
    const { t, headers } = await served()
    const old = t.approvals.askApproval(approval('remote'))
    const fresh = await t.transport.request({ method: 'POST', path: '/api/chat/new', headers, body: {} })
    expect(fresh.status).toBe(200)
    const list = await t.transport.request({ method: 'GET', path: '/api/approvals', headers })
    expect(body(list).approvals).toEqual([])
    const state = await t.transport.request({ method: 'GET', path: '/api/state', headers })
    expect(body(state).approvals).toEqual([])
    const answer = await t.transport.request({
      method: 'POST',
      path: '/api/approvals/answer',
      headers,
      body: { id: old.approvalId, decision: 'allow' }
    })
    expect(answer.status).toBe(409)
    expect(t.approvals.broker.pending()).toHaveLength(1)
  })

  it('AC-8.3: tras un reinicio, un id viejo es desconocido (409 already-answered)', async () => {
    const first = await served()
    const mine = first.t.approvals.askApproval(approval('remote'))
    // A restart is a new empty broker: the old id is gone.
    const second = await served()
    expect(second.t.approvals.broker.pending()).toEqual([])
    const res = await second.t.transport.request({
      method: 'POST',
      path: '/api/approvals/answer',
      headers: second.headers,
      body: { id: mine.approvalId, decision: 'allow' }
    })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'already-answered' })
  })

  it('T21: /api/state trae los approvals con approve prendido (y filtra mensajes sin chat)', async () => {
    const both = await served()
    both.t.approvals.askApproval(approval('remote'))
    const full = await both.t.transport.request({ method: 'GET', path: '/api/state', headers: both.headers })
    expect(body(full).approvals).toHaveLength(1)
    const approveOnly = await served({ chat: false, approve: true, home: false, cameras: false, vault: false, history: false })
    approveOnly.t.approvals.askApproval(approval('remote'))
    const gated = await approveOnly.t.transport.request({ method: 'GET', path: '/api/state', headers: approveOnly.headers })
    expect(body(gated).messages).toEqual([])
    expect(body(gated).approvals).toHaveLength(1)
  })

  it('T21: un long-poll retenido despierta cuando llega y cuando se resuelve un approval', async () => {
    const { t, headers } = await served()
    const first = t.transport.request({ method: 'GET', path: '/api/state', query: 'since=0', headers })
    await held()
    const mine = t.approvals.askApproval(approval('remote'))
    const arrived = await first
    expect(body(arrived).approvals).toHaveLength(1)
    const second = t.transport.request({ method: 'GET', path: '/api/state', query: 'since=0', headers })
    const answer = await t.transport.request({
      method: 'POST',
      path: '/api/approvals/answer',
      headers,
      body: { id: mine.approvalId, decision: 'allow' }
    })
    expect(answer.status).toBe(200)
    const resolved = await second
    expect(body(resolved).approvals).toEqual([])
  })
})
