import { useEffect, useState } from 'react'
import { request } from '../lib/coordinator'

/** Shows an image from the conversation's workspace (loaded through the coordinator as a data URL). */
export function WorkspaceImage({ threadId, path, alt }: { threadId: string; path: string; alt?: string }): React.JSX.Element {
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
  if (error) return <div className="muted small">No se pudo mostrar {path}: {error}</div>
  if (!src) return <div className="image-placeholder" />
  return <img className="post-image" src={src} alt={alt ?? path} title={path} />
}
