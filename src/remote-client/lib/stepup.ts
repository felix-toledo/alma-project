import { b64u } from '../../shared/remote/crypto'
import type { FetchLike, FetchResponse } from './session'

export type StepUpChallengeOutcome =
  | { ok: true; challenge: string }
  | { ok: false; reason: 'unsupported' | 'refused' | 'scope-off' | 'network' | 'rate-limited' }

/**
 * Asks the PC for a step-up challenge. An invalid answer means no passkey is
 * registered for this phone (the phone only asks when a step-up is needed).
 */
export async function requestStepUp(deps: { fetch: FetchLike; token: string; thing: string; action: string }): Promise<StepUpChallengeOutcome> {
  let response: FetchResponse
  try {
    response = await deps.fetch('/api/stepup/challenge', {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ thing: deps.thing, action: deps.action })
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (response.status === 401) return { ok: false, reason: 'refused' }
  if (response.status === 403) return { ok: false, reason: 'scope-off' }
  if (response.status === 429) return { ok: false, reason: 'rate-limited' }
  if (response.status === 400) return { ok: false, reason: 'unsupported' }
  if (!response.ok) return { ok: false, reason: 'network' }
  const body = (await response.json().catch(() => null)) as { challenge?: unknown } | null
  if (!body || typeof body.challenge !== 'string') return { ok: false, reason: 'network' }
  return { ok: true, challenge: body.challenge }
}

/** Raw assertion bytes from the browser's passkey check. */
export interface StepUpAssertionBytes {
  authenticatorData: Uint8Array
  clientDataJSON: Uint8Array
  signature: Uint8Array
}

/**
 * The browser side of the step-up, injected so this module stays DOM-free:
 * `navigator.credentials.get` with the PC's challenge (the thin wrapper lives
 * in the Home screen).
 */
export interface AssertionGetter {
  get(challenge: Uint8Array, rpId: string): Promise<StepUpAssertionBytes | null>
}

export interface EncodedStepUpAssertion {
  authenticatorData: string
  clientDataJSON: string
  signature: string
}

/**
 * Confirms with the passkey (AC-5.20): a refusal or a cancelled prompt reads as
 * null, and the action does not run. The PC's prompt text is the system's own.
 */
export async function assertStepUp(deps: { get: AssertionGetter['get']; challenge: Uint8Array; rpId: string }): Promise<EncodedStepUpAssertion | null> {
  let assertion: StepUpAssertionBytes | null
  try {
    assertion = await deps.get(deps.challenge, deps.rpId)
  } catch {
    return null
  }
  if (!assertion) return null
  return {
    authenticatorData: b64u.encode(assertion.authenticatorData),
    clientDataJSON: b64u.encode(assertion.clientDataJSON),
    signature: b64u.encode(assertion.signature)
  }
}
