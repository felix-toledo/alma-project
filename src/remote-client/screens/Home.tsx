// The house from the phone (T44): rooms, simple toggles, step-up for opening and
// disarming, and the approval cards the actions wait on.
import { House } from 'lucide-react'
import { useCallback, useState } from 'react'
import { stepUpRequired, type SecureAction } from '../../shared/remote/authorize'
import { b64u } from '../../shared/remote/crypto'
import type { ApprovalView } from '../../shared/remote/api'
import { isApproval } from '../lib/conversations'
import { translatePwa, type PwaKey, type PwaLanguage } from '../i18n'
import { thingActions, type PwaThing, type RoomGroup } from '../lib/home'
import { homeEvent, type HouseView } from '../lib/house-view'
import { assertStepUp, type AssertionGetter } from '../lib/stepup'
import type { Pwa } from '../usePwa'
import { ApprovalCard } from './Approvals'
import { PwaHeader } from './Header'
import { StateMessage, StateView } from './StateView'
import { useLoad } from './useLoad'

const ACTION_KEYS: Record<string, PwaKey> = {
  toggle: 'remote.pwa.action.toggle',
  lock: 'remote.pwa.action.lock',
  unlock: 'remote.pwa.action.unlock',
  open: 'remote.pwa.action.open',
  close: 'remote.pwa.action.close',
  arm_home: 'remote.pwa.action.armHome',
  arm_away: 'remote.pwa.action.armAway',
  disarm: 'remote.pwa.action.disarm'
}

const SECURE_ACTIONS: ReadonlySet<string> = new Set(['lock', 'unlock', 'open', 'close', 'arm_home', 'arm_away', 'disarm', 'trigger'])

const browserAssert: AssertionGetter['get'] = async (challenge, rpId) => {
  try {
    const credential = (await navigator.credentials.get({
      publicKey: { challenge: challenge as unknown as ArrayBuffer, rpId, userVerification: 'required' }
    })) as unknown as { response: { authenticatorData: ArrayBuffer; clientDataJSON: ArrayBuffer; signature: ArrayBuffer } } | null
    if (!credential) return null
    return {
      authenticatorData: new Uint8Array(credential.response.authenticatorData),
      clientDataJSON: new Uint8Array(credential.response.clientDataJSON),
      signature: new Uint8Array(credential.response.signature)
    }
  } catch {
    return null
  }
}

type Note = { key: PwaKey } | { text: string }

export function Home({ pwa, language }: { pwa: Pwa; language: PwaLanguage }): React.JSX.Element {
  const t = (key: PwaKey): string => translatePwa(language, key)
  const [note, setNote] = useState<Note | null>(null)
  const [subOff, setSubOff] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const approvals: ApprovalView[] = (pwa.state?.approvals ?? []).filter(isApproval)

  // The house is asked once per visit (and again after an action), never at each poll: `useLoad` reads `pwa` through a ref.
  const { state, reload, refresh } = useLoad<HouseView<RoomGroup[]>>(async () => homeEvent(await pwa.things()), 'home')

  const dance = useCallback(
    async (thing: PwaThing, action: string): Promise<{ authenticatorData: string; clientDataJSON: string; signature: string } | null> => {
      const challenged = await pwa.stepUpChallenge(thing.entityId, action)
      if (!challenged.ok) {
        if (challenged.reason === 'unsupported') setNote({ key: 'remote.pwa.stepUp.unsupported' })
        else if (challenged.reason === 'scope-off') setNote({ key: 'remote.pwa.scopeOff' })
        else if (challenged.reason === 'rate-limited') setNote({ key: 'remote.pwa.rateLimited' })
        else if (challenged.reason === 'network') setNote({ key: 'remote.pwa.pcUnreachable' })
        return null
      }
      const assertion = await assertStepUp({ get: browserAssert, challenge: b64u.decode(challenged.challenge), rpId: location.hostname })
      if (!assertion) setNote({ key: 'remote.pwa.stepUp.failed' })
      return assertion
    },
    [pwa]
  )

  const runAction = useCallback(
    async (thing: PwaThing, action: string, withDance: boolean): Promise<void> => {
      const tag = `${thing.entityId}:${action}`
      setBusy(tag)
      try {
        let assertion: { authenticatorData: string; clientDataJSON: string; signature: string } | undefined
        if (withDance) {
          const danced = await dance(thing, action)
          if (!danced) return
          assertion = danced
        }
        let result = await pwa.control(thing.entityId, action, assertion)
        if (!result.ok && result.reason === 'step-up-required') {
          // The server disagrees about the dance: run it once, then retry once.
          const danced = await dance(thing, action)
          if (!danced) return
          result = await pwa.control(thing.entityId, action, danced)
          if (!result.ok && result.reason === 'step-up-required') {
            setNote({ key: 'remote.pwa.stepUp.failed' })
            return
          }
        }
        if (result.ok) {
          setNote(null)
          await refresh()
          return
        }
        if (result.reason === 'sensitive-off') {
          setSubOff((known) => new Set(known).add(thing.entityId))
          setNote({ key: 'remote.pwa.sensitiveOff' })
        } else if (result.reason === 'scope-off') setNote({ key: 'remote.pwa.scopeOff' })
        else if (result.reason === 'rate-limited') setNote({ key: 'remote.pwa.rateLimited' })
        else if (result.reason === 'network') setNote({ key: 'remote.pwa.pcUnreachable' })
        else if ((result.reason === 'denied' || result.reason === 'invalid') && result.note) setNote({ text: result.note })
      } finally {
        setBusy((current) => (current === tag ? null : current))
      }
    },
    [pwa, dance, refresh]
  )

  const tap = (thing: PwaThing, action: string): void => {
    const needsDance = thing.sensitive && SECURE_ACTIONS.has(action) && stepUpRequired(action as SecureAction)
    void runAction(thing, action, needsDance)
  }

  return (
    <main className="pwa">
      <PwaHeader language={language} title={t('remote.pwa.tab.home')} />
      {note && (
        <p className="pwa-note" role="status">
          {'key' in note ? t(note.key) : note.text}
        </p>
      )}
      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} language={language} onAnswer={(id, decision) => void pwa.answer(id, decision)} />
      ))}
      <StateView state={state} language={language} empty="remote.pwa.home.empty" onRetry={reload}>
        {(view) =>
          view.kind === 'off' ? (
            <StateMessage icon={House} text={view.note ?? t('remote.pwa.scopeOff')} />
          ) : (
            view.data.map((room, index) => (
              // Rooms have no stable id on the phone (the name is the heading); things keep entity keys.
              <section key={room.area ?? `none-${index}`} aria-label={room.area ?? undefined}>
                {room.area && <h2 className="pwa-section">{room.area}</h2>}
                <ul className="pwa-things">
                  {room.things.map((thing) => (
                    <li key={thing.entityId}>
                      <div className="pwa-thing">
                        <strong>{thing.name}</strong>
                        <span className="pwa-muted">{thing.state}</span>
                      </div>
                      <div className="pwa-actions">
                        {thingActions(thing)
                          .filter((action) => Object.hasOwn(ACTION_KEYS, action))
                          .map((action) => (
                            <button key={action} type="button" disabled={busy !== null || (thing.sensitive && subOff.has(thing.entityId))} onClick={() => tap(thing, action)}>
                              {t(ACTION_KEYS[action])}
                            </button>
                          ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )
        }
      </StateView>
    </main>
  )
}
