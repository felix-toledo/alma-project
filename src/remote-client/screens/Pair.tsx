// Pairing from the phone (T42, installed-only in T51): scan, verify the PC, show the code, wait for approval.
import { useEffect, useRef, useState } from 'react'
import { b64u, fingerprint } from '../../shared/remote/crypto'
import { phoneLanguage, translatePwa, type PwaKey, type PwaLanguage } from '../i18n'
import { pwaFetch } from '../http'
import { idbStorage } from '../idb'
import { generateDeviceKey } from '../lib/keys'
import { PwaHeader } from './Header'
import { checkHello, deriveCode, isInstalledApp, pairRequestErrorKey, parsePairFragment, pollPairStatus, requestPair } from '../lib/pairing'
import { registerPasskey, submitPasskey, type PasskeyCreator } from '../lib/webauthn'

/** The browser side of passkey creation: ES256 only, user verification required, no attestation. */
const browserPasskey: PasskeyCreator['create'] = async (challenge, rpId, userId) => {
  try {
    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge: challenge as unknown as ArrayBuffer,
        rp: { name: 'Alma', id: rpId },
        user: { id: userId as unknown as ArrayBuffer, name: 'alma-phone', displayName: 'Alma phone' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        attestation: 'none',
        authenticatorSelection: { userVerification: 'required' }
      }
    })) as unknown as { response: { attestationObject: ArrayBuffer; clientDataJSON: ArrayBuffer } } | null
    if (!credential) return null
    return {
      attestationObject: new Uint8Array(credential.response.attestationObject),
      clientDataJSON: new Uint8Array(credential.response.clientDataJSON)
    }
  } catch {
    return null
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type View = { stage: 'starting' } | { stage: 'code'; code: string } | { stage: 'error'; key: PwaKey } | { stage: 'passkey'; note: PwaKey }

export function Pair({ onPaired }: { onPaired(deviceId: string): void }): React.JSX.Element {
  const language: PwaLanguage = phoneLanguage(navigator.language)
  const t = (key: PwaKey): string => translatePwa(language, key)
  const [view, setView] = useState<View>({ stage: 'starting' })
  // Pairing runs only inside the installed app (T51): a tab only shows install
  // instructions and never touches the fragment, so the installed launch keeps it.
  const [installed] = useState(() =>
    isInstalledApp({
      displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
      navigatorStandalone: (navigator as { standalone?: boolean }).standalone
    })
  )

  // The flow runs exactly once per mount: the fragment is single-use and is stripped from the
  // URL at the start, so a re-run (a parent re-render handing a new onPaired, StrictMode's
  // double effect) would find no fragment and show "code spent" on a perfectly good QR.
  const started = useRef(false)
  const mounted = useRef(false)
  const paired = useRef(onPaired)
  paired.current = onPaired
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!installed || started.current) return
    started.current = true
    const alive = (): boolean => mounted.current
    const show = (next: View): void => {
      if (alive()) setView(next)
    }

    void (async () => {
      const fragment = parsePairFragment(location.hash)
      history.replaceState(null, '', location.pathname)
      if (!fragment) return show({ stage: 'error', key: 'remote.pwa.pairing.rescan' })
      const hello = await checkHello({ fetch: pwaFetch, expectedFingerprint: fragment.fingerprint })
      if (!alive()) return
      if (!hello.ok) return show({ stage: 'error', key: hello.reason === 'mismatch' ? 'remote.pwa.fingerprint' : 'remote.pwa.pcUnreachable' })
      const device = await generateDeviceKey()
      const requested = await requestPair({ fetch: pwaFetch, secret: fragment.secret, phonePublicKey: device.publicJwk })
      if (!alive()) return
      if (!requested.ok) return show({ stage: 'error', key: pairRequestErrorKey(requested.reason) })
      const code = await deriveCode({ secret: fragment.secret, phoneKey: device.publicJwk, pcNonce: requested.pcNonce })
      show({ stage: 'code', code })
      const fp = await fingerprint(device.publicJwk)
      for (;;) {
        await sleep(2000)
        if (!alive()) return
        if (Date.now() > requested.expiresAt + 30_000) return show({ stage: 'error', key: 'remote.pwa.pairing.expired' })
        const status = await pollPairStatus({ fetch: pwaFetch, offer: fragment.secret, pcNonce: requested.pcNonce, fp })
        if (!alive()) return
        if (!status.ok) {
          if (status.reason === 'network') continue
          return show({ stage: 'error', key: 'remote.pwa.pairing.expired' })
        }
        if (status.status === 'pending') continue
        if (status.status !== 'approved') {
          const key =
            status.status === 'rejected'
              ? 'remote.pwa.pairing.rejected'
              : status.status === 'expired'
                ? 'remote.pwa.pairing.expired'
                : 'remote.pwa.rateLimited'
          return show({ stage: 'error', key })
        }
        await idbStorage().saveDevice({ deviceId: status.deviceId, privateKey: device.privateKey, publicJwk: device.publicJwk })
        if (status.passkeyChallenge) {
          const attestation = await registerPasskey({
            create: browserPasskey,
            challenge: b64u.decode(status.passkeyChallenge),
            rpId: location.hostname,
            userId: crypto.getRandomValues(new Uint8Array(32))
          })
          const submitted = attestation
            ? await submitPasskey({ fetch: pwaFetch, offer: fragment.secret, pcNonce: requested.pcNonce, ...attestation })
            : null
          if (!alive()) return
          if (!submitted?.ok) {
            // No passkey, still paired (AC-4.13): say so, then move on.
            show({ stage: 'passkey', note: 'remote.pwa.passkey.none' })
            await sleep(4000)
            if (!alive()) return
          }
        }
        paired.current(status.deviceId)
        return
      }
    })()
  }, [installed])

  if (!installed) {
    return (
      <main className="pwa">
        <PwaHeader language={language} />
        <p className="pwa-note">{t('remote.pwa.pairing.installFirst')}</p>
      </main>
    )
  }

  return (
    <main className="pwa">
      <PwaHeader language={language} />
      {view.stage === 'starting' && (
        <>
          <span className="pwa-spinner" aria-hidden="true" />
          <p className="pwa-note">{t('remote.pwa.pairing.waiting')}</p>
        </>
      )}
      {view.stage === 'code' && (
        <>
          <p className="pwa-code">{view.code}</p>
          <span className="pwa-spinner" aria-hidden="true" />
          <p className="pwa-note">{t('remote.pwa.pairing.waiting')}</p>
        </>
      )}
      {view.stage === 'passkey' && <p className="pwa-note">{t(view.note)}</p>}
      {view.stage === 'error' && <p className="pwa-error">{t(view.key)}</p>}
    </main>
  )
}
