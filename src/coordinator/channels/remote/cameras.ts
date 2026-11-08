import { randomUUID } from 'node:crypto'
import type { Authorization } from '../../approval'
import type { HomeService } from '../../home'
import { toolTrail } from '../../tool-trail'
import { shownError } from '../../tools/types'
import { translate } from '../../../shared/i18n/messages'
import { REMOTE_LIMITS, type RemoteResponse } from '../../../shared/remote/api'
import type { Settings } from '../../../shared/types'
import type { DirectTools } from './home'
import { refusalResponse } from './transport'

export interface CamerasDeps {
  settings(): Settings
  /** The current shared remote thread: approvals of a phone call belong to it. */
  conversationId(): string
  /** The agent chosen for the remote thread: the trail's agent. */
  agentId(): string
  direct: DirectTools
}

/**
 * Camera stills (T24): one picture through the existing `cameraSnapshot`, authorized as
 * a `write` call like `camera_look` (AC-5.19), seen in transit only — nothing is saved
 * to the inbox or anywhere else (AC-5.11, BR-26). No vision question is ever asked.
 */
export class CamerasFlow {
  constructor(private readonly deps: CamerasDeps) {}

  /** Only allow-listed cameras (AC-5.22); an empty list shows nothing. */
  async list(): Promise<RemoteResponse> {
    const settings = this.deps.settings()
    const service = this.deps.direct.home
    if (!service || !settings.home.enabled) return this.houseOff(settings, translate(settings.language, 'tool.home.off'))
    const down = this.notReady(settings, service)
    if (down) return down
    const allowed = settings.remote.cameras
    const cameras = service.hub
      .snapshot()
      .things.filter((thing) => thing.kind === 'camera' && allowed.includes(thing.entityId))
      .map((thing) => ({ id: thing.id, entityId: thing.entityId, name: thing.name, state: thing.state }))
    return { status: 200, headers: { 'cache-control': 'no-store' }, body: { cameras } }
  }

  async still(cameraId: string | null): Promise<RemoteResponse> {
    const settings = this.deps.settings()
    const service = this.deps.direct.home
    if (!service || !settings.home.enabled) return this.houseOff(settings, translate(settings.language, 'tool.home.off'))
    const down = this.notReady(settings, service)
    if (down) return down
    // The pipeline already refused ids outside the allow-list (AC-3.3); what can still
    // arrive is a listed id that is not a camera, or none at all.
    const thing = cameraId ? service.hub.thing(cameraId) : undefined
    if (!thing || thing.kind !== 'camera') {
      const note = translate(settings.language, 'tool.ha.notCamera')
      return { status: 400, headers: { 'cache-control': 'no-store' }, body: { error: 'invalid', note } }
    }
    const input = { camera: thing.entityId }
    const authorization: Authorization = await this.deps.direct.authorize({
      settings,
      threadId: this.deps.conversationId(),
      toolUseId: randomUUID(),
      toolName: 'camera_look',
      risk: 'write',
      input,
      workspace: '',
      taskContext: '',
      autoApprove: [],
      signal: new AbortController().signal,
      language: settings.language,
      setState: () => {}
    })
    const trail = { risk: 'write' as const, name: 'camera_look', input, threadId: this.deps.conversationId(), agentId: this.deps.agentId(), note: authorization.note }
    if (!authorization.allowed) {
      toolTrail(trail, 'denied', 'tool.authorize')
      return { status: 403, headers: { 'cache-control': 'no-store' }, body: { error: 'denied', note: authorization.note } }
    }
    let jpeg: Buffer
    try {
      jpeg = await service.hub.cameraSnapshot(thing.entityId)
    } catch (error) {
      toolTrail(trail, 'error', 'tool.run')
      const note = error instanceof Error ? shownError(error, settings.language) : String(error)
      return { status: 500, headers: { 'cache-control': 'no-store' }, body: { error: 'failed', note } }
    }
    if (jpeg.length > REMOTE_LIMITS.photoBytes) {
      toolTrail(trail, 'error', 'tool.run')
      return refusalResponse('too-large')
    }
    toolTrail(trail, 'ok', 'tool.run')
    return { status: 200, headers: { 'cache-control': 'no-store' }, body: { photo: jpeg.toString('base64'), mediaType: 'image/jpeg' } }
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
}
