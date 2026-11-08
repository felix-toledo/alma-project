import { randomUUID } from 'node:crypto'
import type { Authorization, AuthorizationRequest } from '../../approval'
import type { HomeService } from '../../home'
import { toolTrail } from '../../tool-trail'
import { homeControlTool, homeSecureControlTool } from '../../tools/home'
import { shownError, ToolError, type ToolContext, type ToolDefinition } from '../../tools/types'
import { isSensitive, type HomeThing } from '../../../shared/home'
import { translate } from '../../../shared/i18n/messages'
import type { RemoteResponse } from '../../../shared/remote/api'
import type { Settings } from '../../../shared/types'
import { needsStepUp, type StepUpAssertion, type StepUpFlow } from './stepup'
import { refusalResponse } from './transport'

/**
 * The narrow API's direct tools (plan 3/5): the house behind the tools, the factory
 * for their context, and `authorize` with the broker already bound (T35 binds the real
 * one; tests bind the real `authorize` over the harness broker).
 */
export interface DirectTools {
  home: HomeService | null
  toolContext(): ToolContext
  authorize(request: Omit<AuthorizationRequest, 'broker' | 'rememberAlwaysAllow'>): Promise<Authorization>
}

export interface HomeDeps {
  settings(): Settings
  /** The current shared remote thread: approvals of a phone call belong to it. */
  conversationId(): string
  /** The agent chosen for the remote thread: the trail's agent. */
  agentId(): string
  direct: DirectTools
  stepUp: StepUpFlow
}

/** Secure-only actions; open/close ride along once the thing proves sensitive. */
const SECURE_ACTIONS = ['lock', 'unlock', 'arm_home', 'arm_away', 'disarm', 'trigger']
/** Everyday actions; open/close ride along once the thing proves ordinary. */
const EVERYDAY_ACTIONS = ['on', 'off', 'toggle', 'set', 'play', 'pause', 'stop', 'next', 'previous']

function narrowAssertion(value: unknown): StepUpAssertion | null {
  if (!value || typeof value !== 'object') return null
  const { authenticatorData, clientDataJSON, signature } = value as Record<string, unknown>
  if (typeof authenticatorData !== 'string' || !authenticatorData) return null
  if (typeof clientDataJSON !== 'string' || !clientDataJSON) return null
  if (typeof signature !== 'string' || !signature) return null
  return { authenticatorData, clientDataJSON, signature }
}

/**
 * Direct house control (T23): the narrow API over the same functions, risk and approval
 * policy as the `home_*` tools (BR-13). Sensitive things never go through the everyday
 * control (spec 013 AC-6.1): the tool itself refuses them and names the secure one.
 */
export class HomeFlow {
  constructor(private readonly deps: HomeDeps) {}

  /** The things with what the phone needs to offer them: id, state and sensitivity. */
  async things(): Promise<RemoteResponse> {
    const settings = this.deps.settings()
    const service = this.deps.direct.home
    if (!service || !settings.home.enabled) return this.houseOff(settings, translate(settings.language, 'tool.home.off'))
    const down = this.notReady(settings, service)
    if (down) return down
    const snapshot = service.hub.snapshot()
    return {
      status: 200,
      headers: { 'cache-control': 'no-store' },
      body: {
        things: snapshot.things.map((thing) => ({
          id: thing.id,
          entityId: thing.entityId,
          name: thing.name,
          kind: thing.kind,
          areaId: thing.areaId,
          state: thing.state,
          sensitive: isSensitive(thing.kind, thing.deviceClass)
        })),
        areas: snapshot.areas.map((area) => ({ id: area.id, name: area.name }))
      }
    }
  }

  async control(deviceId: string, thing: string, action: string, assertion: unknown): Promise<RemoteResponse> {
    const settings = this.deps.settings()
    const service = this.deps.direct.home
    if (!service || !settings.home.enabled) return this.houseOff(settings, translate(settings.language, 'tool.home.off'))
    const down = this.notReady(settings, service)
    if (down) return down
    if (SECURE_ACTIONS.includes(action)) return this.secure(deviceId, thing, action, assertion)
    if (EVERYDAY_ACTIONS.includes(action)) return this.everyday(thing, action)
    if (action === 'open' || action === 'close') {
      const found = this.find(service, settings, thing)
      if (!found.ok) return found.response
      if (isSensitive(found.thing.kind, found.thing.deviceClass)) {
        return this.secure(deviceId, thing, action, assertion)
      }
      return this.everyday(thing, action)
    }
    return refusalResponse('invalid')
  }

  private async secure(deviceId: string, thing: string, action: string, assertion: unknown): Promise<RemoteResponse> {
    const settings = this.deps.settings()
    if (!settings.remote.sensitive) return refusalResponse('sensitive-off')
    const parsed = homeSecureControlTool.schema.safeParse({ target: thing, action })
    if (!parsed.success) return refusalResponse('invalid')
    if (needsStepUp(action)) {
      const narrowed = narrowAssertion(assertion)
      const verified = narrowed ? await this.deps.stepUp.verify(deviceId, thing, action, narrowed) : { ok: false as const }
      if (!verified.ok) return refusalResponse('step-up-required')
    }
    return this.runTool(settings, homeSecureControlTool, parsed.data)
  }

  private async everyday(thing: string, action: string): Promise<RemoteResponse> {
    const settings = this.deps.settings()
    const parsed = homeControlTool.schema.safeParse({ target: thing, action })
    if (!parsed.success) return refusalResponse('invalid')
    return this.runTool(settings, homeControlTool, parsed.data)
  }

  /**
   * One phone-initiated tool call: authorize with the tool's own risk through the same
   * broker the phone answers on, run the same function, and leave the tool's audit
   * entry through tool-trail; the pipeline adds the remote one (AC-7.7).
   */
  private async runTool(settings: Settings, tool: ToolDefinition, input: unknown): Promise<RemoteResponse> {
    const ctx = this.deps.direct.toolContext()
    const preview = tool.preview ? await tool.preview(input, ctx).catch(() => undefined) : undefined
    const authorization = await this.deps.direct.authorize({
      settings,
      threadId: this.deps.conversationId(),
      toolUseId: randomUUID(),
      toolName: tool.name,
      risk: tool.risk,
      input,
      workspace: '',
      taskContext: '',
      autoApprove: [],
      preview,
      signal: new AbortController().signal,
      language: settings.language,
      setState: () => {}
    })
    const trail = { risk: tool.risk, name: tool.name, input, threadId: this.deps.conversationId(), agentId: this.deps.agentId(), note: authorization.note }
    if (!authorization.allowed) {
      toolTrail(trail, 'denied', 'tool.authorize')
      return { status: 403, headers: { 'cache-control': 'no-store' }, body: { error: 'denied', note: authorization.note } }
    }
    try {
      const state = await tool.run(input, ctx)
      toolTrail(trail, 'ok', 'tool.run')
      return { status: 200, headers: { 'cache-control': 'no-store' }, body: { ok: true, state } }
    } catch (error) {
      toolTrail(trail, 'error', 'tool.run')
      return this.toolFailure(settings, error)
    }
  }

  /** A tool failure in the person's language, never a blank (AC-5.10). */
  private toolFailure(settings: Settings, error: unknown): RemoteResponse {
    const note = error instanceof Error ? shownError(error, settings.language) : String(error)
    if (error instanceof ToolError && error.text.key.startsWith('tool.ha.')) {
      return { status: 503, headers: { 'cache-control': 'no-store' }, body: { error: 'house-off', note } }
    }
    if (error instanceof ToolError) {
      return { status: 400, headers: { 'cache-control': 'no-store' }, body: { error: 'invalid', note } }
    }
    return { status: 500, headers: { 'cache-control': 'no-store' }, body: { error: 'failed', note } }
  }

  private houseOff(settings: Settings, note: string): RemoteResponse {
    return { status: 503, headers: { 'cache-control': 'no-store' }, body: { error: 'house-off', note } }
  }

  private notReady(settings: Settings, service: HomeService): RemoteResponse | null {
    if (service.hub.ready) return null
    const { state, error, step } = service.engine.status()
    const status = `${state}${error ? `: ${error}` : step ? `: ${step}` : ''}`
    return this.houseOff(settings, translate(settings.language, 'tool.home.notConnected', { status }))
  }

  private invalid(note: string): RemoteResponse {
    return { status: 400, headers: { 'cache-control': 'no-store' }, body: { error: 'invalid', note } }
  }

  /** Mirrors resolve()/exactlyOne() of tools/home.ts: exact ids first, never several. */
  private find(service: HomeService, settings: Settings, thing: string): { ok: true; thing: HomeThing } | { ok: false; response: RemoteResponse } {
    const matches = service.hub.find(thing)
    if (matches.length === 1) return { ok: true, thing: matches[0] as HomeThing }
    const language = settings.language
    if (!matches.length) {
      const all = service.hub.snapshot().things
      if (!all.length) return { ok: false, response: this.invalid(translate(language, 'tool.home.notFoundNone', { target: thing })) }
      return { ok: false, response: this.invalid(translate(language, 'tool.home.notFound', { target: thing, names: all.map((t) => t.name).join(', ') })) }
    }
    return {
      ok: false,
      response: this.invalid(
        translate(language, 'tool.home.several', { target: thing, count: matches.length, names: matches.map((t) => `${t.name} (${t.entityId})`).join(', ') })
      )
    }
  }
}
