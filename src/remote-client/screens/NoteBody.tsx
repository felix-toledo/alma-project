// A note rendered as the desktop's reading mode does (components/Markdown.tsx): GitHub-flavored Markdown, raw HTML never
// rendered. Which links open and which image sources load is decided in lib/markdown.ts; this only draws the verdict.
import { Image as ImageIcon, ImageOff } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { translatePwa, type PwaKey, type PwaLanguage } from '../i18n'
import { useLatest } from '../lib/latest'
import { classifyLink, imageTarget } from '../lib/markdown'
import type { ImageOutcome } from '../lib/notes'
import { imageDataUrl, imageFailureKey } from '../lib/notes-view'

type FetchImage = (target: string, from: string) => Promise<ImageOutcome>
type Picture = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; src: string } | { kind: 'failed'; key: PwaKey }

function Slot({ icon: Icon, text, busy }: { icon: typeof ImageIcon; text: string; busy?: boolean }): React.JSX.Element {
  return (
    <span className="pwa-image" aria-busy={busy || undefined}>
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      {text}
    </span>
  )
}

/**
 * A picture of the vault, asked of the PC only when it is about to be seen (every fetch counts against the 60 a minute) and
 * shown as a data: URL, so the phone never calls any address a note names (AC-2.12).
 */
export function NoteImage({ target, from, alt, language, fetchImage }: { target: string; from: string; alt: string; language: PwaLanguage; fetchImage: FetchImage }): React.JSX.Element {
  const t = (key: PwaKey): string => translatePwa(language, key)
  const slot = useRef<HTMLSpanElement>(null)
  const ask = useLatest(fetchImage)
  const [near, setNear] = useState(false)
  const [picture, setPicture] = useState<Picture>({ kind: 'idle' })

  useEffect(() => {
    const element = slot.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver((seen) => seen.some((one) => one.isIntersecting) && setNear(true), { rootMargin: '200px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!near) return
    let alive = true
    setPicture({ kind: 'loading' })
    void ask.current(target, from).then((outcome) => {
      if (!alive) return
      if (!outcome.ok) return setPicture({ kind: 'failed', key: imageFailureKey(outcome.reason) })
      const src = imageDataUrl(outcome.photo, outcome.mediaType)
      setPicture(src ? { kind: 'ready', src } : { kind: 'failed', key: 'remote.pwa.image.blocked' })
    })
    return () => {
      alive = false
    }
  }, [near, target, from, ask])

  return (
    <span ref={slot} className="pwa-image-slot">
      {picture.kind === 'ready' ? (
        <img src={picture.src} alt={alt} loading="lazy" decoding="async" />
      ) : picture.kind === 'failed' ? (
        <Slot icon={ImageOff} text={t(picture.key)} />
      ) : (
        <Slot icon={ImageIcon} text={t('remote.pwa.loading')} busy />
      )}
    </span>
  )
}

type BodyProps = {
  text: string
  notePath: string
  language: PwaLanguage
  fetchImage: FetchImage
  onOpenNote(path: string): void
}

/**
 * Memoized on what it draws: the shell re-renders at every poll with new callbacks, and rebuilding the renderer's components would
 * remount every image (asking the PC for each again, 60 a minute) and re-parse a long note. The callbacks are read through a ref.
 */
export const NoteBody = memo(
  function NoteBody({ text, notePath, language, fetchImage, onOpenNote }: BodyProps): React.JSX.Element {
    const latest = useLatest({ fetchImage, onOpenNote })
    const components = useMemo<Components>(
      () => ({
        a: ({ href, children }) => {
          const link = classifyLink(href ?? '', notePath)
          if (link.kind === 'note') {
            return (
              <button type="button" className="pwa-link" onClick={() => latest.current.onOpenNote(link.path)}>
                {children}
              </button>
            )
          }
          // A tap on an external address opens it in a new context; nothing is fetched before.
          if (link.kind === 'external') {
            return (
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            )
          }
          return <span>{children}</span>
        },
        img: ({ src, alt }) => {
          const source = imageTarget(typeof src === 'string' ? src : undefined)
          if (source.kind === 'blocked') return <Slot icon={ImageOff} text={translatePwa(language, 'remote.pwa.image.blocked')} />
          return <NoteImage target={source.target} from={notePath} alt={alt ?? ''} language={language} fetchImage={(target, from) => latest.current.fetchImage(target, from)} />
        }
      }),
      [notePath, language, latest]
    )
    return (
      <div className="pwa-prose">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {text}
        </ReactMarkdown>
      </div>
    )
  },
  (before, after) => before.text === after.text && before.notePath === after.notePath && before.language === after.language
)
