import type { FetchLike, FetchResponse } from './session'

export interface PwaCamera {
  id: string
  entityId: string
  name: string
  state: string
}

export type CamerasOutcome =
  | { ok: true; cameras: PwaCamera[] }
  | { ok: false; reason: 'refused' | 'scope-off' | 'house-off' | 'network' | 'rate-limited'; note?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCamera(value: unknown): value is PwaCamera {
  return (
    isRecord(value) && typeof value.id === 'string' && typeof value.entityId === 'string' && typeof value.name === 'string' && typeof value.state === 'string'
  )
}

/** Lists the allowed cameras. */
export async function fetchCameras(deps: { fetch: FetchLike; token: string }): Promise<CamerasOutcome> {
  let response: FetchResponse
  try {
    response = await deps.fetch('/api/cameras', { headers: { authorization: `Bearer ${deps.token}` } })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (response.status === 401) return { ok: false, reason: 'refused' }
  if (response.status === 403) return { ok: false, reason: 'scope-off' }
  if (response.status === 429) return { ok: false, reason: 'rate-limited' }
  const body = await response.json().catch(() => null)
  if (response.status === 503) {
    return { ok: false, reason: 'house-off', note: isRecord(body) && typeof body.note === 'string' ? body.note : undefined }
  }
  if (!response.ok) return { ok: false, reason: 'network' }
  if (!isRecord(body) || !Array.isArray(body.cameras)) return { ok: false, reason: 'network' }
  return { ok: true, cameras: body.cameras.filter(isCamera) }
}

export type StillOutcome =
  | { ok: true; photo: string; mediaType: string }
  | { ok: false; reason: 'refused' | 'scope-off' | 'camera-off' | 'photo-too-big' | 'denied' | 'network' | 'rate-limited'; note?: string }

/** Fetches one still (base64); over-2 MB pictures are refused, never truncated. */
export async function fetchStill(deps: { fetch: FetchLike; token: string; entityId: string }): Promise<StillOutcome> {
  let response: FetchResponse
  try {
    response = await deps.fetch(`/api/cameras/still?id=${encodeURIComponent(deps.entityId)}`, { headers: { authorization: `Bearer ${deps.token}` } })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (response.status === 401) return { ok: false, reason: 'refused' }
  if (response.status === 413) return { ok: false, reason: 'photo-too-big' }
  if (response.status === 429) return { ok: false, reason: 'rate-limited' }
  const body = await response.json().catch(() => null)
  if (response.status === 403) {
    const error = isRecord(body) && typeof body.error === 'string' ? body.error : ''
    if (error === 'camera-not-allowed') return { ok: false, reason: 'camera-off' }
    if (error === 'denied') return { ok: false, reason: 'denied', note: isRecord(body) && typeof body.note === 'string' ? body.note : undefined }
    return { ok: false, reason: 'scope-off' }
  }
  if (!response.ok) return { ok: false, reason: 'network' }
  if (!isRecord(body) || typeof body.photo !== 'string' || typeof body.mediaType !== 'string') return { ok: false, reason: 'network' }
  return { ok: true, photo: body.photo, mediaType: body.mediaType }
}
