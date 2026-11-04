import { useEffect, useState } from 'react'
import { useT } from '../i18n/useT'
import { request } from '../lib/coordinator'

/** Shows an image from the conversation's workspace (loaded through the coordinator as a data URL). */
export function WorkspaceImage({ threadId, path, alt }: { threadId: string; path: string; alt?: string }): React.JSX.Element {
  const t = useT()
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    request<string>({ method: 'files.image', threadId, path })
      .then((url) => alive && setSrc(url))
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [threadId, path])
  if (error) return <div className="muted small">{t('workspaceImage.failed', { path, error })}</div>
  if (!src) return <div className="image-placeholder" />
  return <img className="post-image" src={src} alt={alt ?? path} title={path} />
}
