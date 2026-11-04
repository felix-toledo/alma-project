import { memo, useEffect, useRef } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { DRAWING_EXT } from '../../../shared/excalidraw'
import { useT } from '../i18n/useT'
import { drawingSvg } from '../vault/drawing'
import { openNote, vaultPathOf } from '../vault/vaultLib'

interface Props {
  text: string
  /** Vault notes: maps an image reference to a loadable URL (alma-vault://…). */
  resolveImage?(src: string): string | null
}

/** A drawing embedded in a note (reading view). */
function DrawingEmbed({ src }: { src: string }): React.JSX.Element {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false
    drawingSvg(src, t)
      .then((svg) => !cancelled && box.current?.replaceChildren(svg))
      .catch((error: Error) => !cancelled && box.current && (box.current.textContent = error.message))
    return () => {
      cancelled = true
    }
  }, [src, t])
  return (
    <div ref={box} className="cm-drawing" title={t('vault.drawing.openTitle')} onDoubleClick={() => openNote(vaultPathOf(src))}>
      {t('vault.drawing.loading')}
    </div>
  )
}

/** Model output and vault notes rendered as GitHub-flavored markdown. Raw HTML is not rendered. */
export const Markdown = memo(function Markdown({ text, resolveImage }: Props): React.JSX.Element {
  const t = useT()
  // Wiki-style embeds (![[foto.png]]) become regular images so the resolver can find them.
  const source = resolveImage ? text.replace(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, (_m, name: string) => `![${name}](<${name.trim()}>)`) : text
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) => (key === 'src' && url.startsWith('alma-vault://') ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) =>
            // Agents cite vault notes as relative links: open them in the vault instead of a browser.
            href && !/^[a-z][\w+.-]*:/i.test(href) && /\.md(#.*)?$/i.test(href) ? (
              <button className="link" onClick={() => openNote(decodeURI(href.replace(/#.*$/, '')))}>
                {children}
              </button>
            ) : (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
          img: ({ src, alt }) => {
            if (!resolveImage) {
              // A remote image is a request to an address the model wrote (it could carry data out): never loaded, the CSP agrees.
              return typeof src === 'string' && src.startsWith('alma-vault://') ? <img src={src} alt={alt ?? ''} className="note-image" /> : <span className="muted">{alt ? t('markdown.remoteBlockedAlt', { alt }) : t('markdown.remoteBlocked')}</span>
            }
            const resolved = typeof src === 'string' ? resolveImage(decodeURI(src)) : null
            if (resolved && DRAWING_EXT.test(resolved)) return <DrawingEmbed src={resolved} />
            return resolved ? <img src={resolved} alt={alt ?? ''} className="note-image" /> : <span className="muted">{t('markdown.notFound', { src: String(src) })}</span>
          }
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
})
