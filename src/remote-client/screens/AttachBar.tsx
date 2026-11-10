// The files part of the composer (spec 031 T52): the attach button, one chip per file and the lines that explain a refusal.
// Names are React text nodes, never markup, a link or an attribute built from them (AC-8.8).
import { Paperclip, RotateCw, X } from 'lucide-react'
import { useRef } from 'react'
import type { Chip } from '../../shared/attach/phone-chips'
import { ALLOWED_EXTENSIONS } from '../../shared/attach/rules'
import { translatePwa, type PwaLanguage } from '../i18n'
import { attachOutcomeKey, attachRetryOffered } from '../lib/outcome'
import type { Attachments } from './useAttachments'

// A convenience for the chooser (the PC re-checks every file): pictures, then the 030 extensions. No `capture`, so the phone's own
// sheet offers the camera, the photo library and the files. Named picture types, not `image/*`: iOS then converts a HEIC photo to JPEG.
const ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', ...Object.keys(ALLOWED_EXTENSIONS)].join(',')

type Props = { attach: Attachments; language: PwaLanguage }

export function AttachButton({ attach, language, running }: Props & { running: boolean }): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button
        type="button"
        className="ghost pwa-icon"
        aria-label={translatePwa(language, 'remote.pwa.attach.button')}
        disabled={!attach.button.enabled || running}
        onClick={() => input.current?.click()}
      >
        <Paperclip size={20} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={ACCEPT}
        onChange={(event) => {
          // Copy before clearing: the same file can then be picked again, and cancelling the chooser changes nothing.
          const picked = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (picked.length > 0) attach.pick(picked)
        }}
      />
    </>
  )
}

function chipText(chip: Chip, language: PwaLanguage): string {
  if (chip.state === 'preparing') return translatePwa(language, 'remote.pwa.attach.preparing', { name: chip.name })
  if (chip.state === 'uploading') return translatePwa(language, 'remote.pwa.attach.uploading', { name: chip.name })
  return chip.name
}

/** `locked`: a send is in flight, so the files it carries can no longer be changed. */
export function AttachChips({ attach, language, locked = false }: Props & { locked?: boolean }): React.JSX.Element | null {
  if (attach.chips.length === 0) return null
  return (
    <ul className="pwa-actions pwa-list">
      {attach.chips.map((chip) => (
        <li key={chip.key} className="pwa-chip" data-state={chip.state} aria-busy={chip.state === 'preparing' || chip.state === 'uploading' ? true : undefined}>
          <span>{chipText(chip, language)}</span>
          {chip.state === 'failed' && chip.reason && attachRetryOffered(chip.reason) && (
            <button type="button" className="ghost pwa-icon" aria-label={translatePwa(language, 'remote.pwa.retry')} disabled={locked} onClick={() => attach.retry(chip.key)}>
              <RotateCw size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="ghost pwa-icon"
            aria-label={translatePwa(language, 'remote.pwa.attach.remove', { name: chip.name })}
            disabled={locked}
            onClick={() => attach.remove(chip.key)}
          >
            <X size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  )
}

/** For the `role="status"` region: why the button is off, and for each failed chip its one concrete reason. */
export function AttachNotes({ attach, language }: Props): React.JSX.Element {
  return (
    <>
      {attach.known && attach.button.reason && <p className="pwa-note">{translatePwa(language, attach.button.reason)}</p>}
      {attach.chips.map(
        (chip) =>
          chip.state === 'failed' && (
            <p key={chip.key} className="pwa-error">
              {translatePwa(language, attachOutcomeKey(chip.reason ?? 'unreadable'), { name: chip.name })}
            </p>
          )
      )}
    </>
  )
}
