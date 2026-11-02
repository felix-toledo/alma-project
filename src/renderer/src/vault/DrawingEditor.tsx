import '@excalidraw/excalidraw/index.css'
import { Excalidraw, getSceneVersion, serializeAsJSON } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { MessageSquarePlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { parseDrawing, type DrawingElement, type DrawingFile } from '../../../shared/excalidraw'
import { drawingAttachment, type Attachment } from '../lib/attachments'
import { Icon } from '../umbra/Icon'
import { applyOps, isDark, loadExcalidraw } from './drawing'

void loadExcalidraw() // sets the font path before the first drawing renders

interface Props {
  path: string
  /** The file as on disk (or as last edited); a different value from outside (an agent's change) is loaded in. */
  content: string
  onChange(content: string): void
  onAsk(attachment: Attachment): void
}

/** The app follows its own theme toggle (data-theme on <html>), so the canvas does too. */
function useTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState(isDark() ? 'dark' : 'light')
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(isDark() ? 'dark' : 'light'))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme as 'dark' | 'light'
}

const serialize = (elements: readonly ExcalidrawElement[], appState: Partial<AppState>, files: BinaryFiles): string =>
  serializeAsJSON(elements, appState, files, 'local')

/** A .excalidraw file in the vault: draw by hand, see what agents drew, and hand a selection to the chat. */
export default function DrawingEditor({ path, content, onChange, onAsk }: Props): React.JSX.Element {
  const theme = useTheme()
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [scene, setScene] = useState<DrawingFile | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  /** The JSON this editor last loaded or produced: anything else in `content` came from outside. */
  const known = useRef<string | null>(null)
  const version = useRef(-1)
  const latest = useRef({ onChange })
  latest.current = { onChange }

  useEffect(() => {
    if (content === known.current) return
    let cancelled = false
    void applyOps(parseDrawing(content)).then(({ drawing, changed }) => {
      if (cancelled) return
      const json = changed ? JSON.stringify(drawing, null, 2) : content
      known.current = json
      if (!scene) setScene(drawing)
      else if (api) {
        api.updateScene({ elements: drawing.elements as unknown as ExcalidrawElement[] })
        api.addFiles(Object.values(drawing.files) as never)
      }
      // What an agent queued is now drawn: save it so the file is plain Excalidraw again.
      if (changed) latest.current.onChange(json)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, api])

  if (!scene) return <div className="vault-empty muted">Cargando dibujo…</div>

  const ask = (): void => {
    const elements = (api?.getSceneElements() ?? []) as unknown as DrawingElement[]
    onAsk(drawingAttachment(path, elements, selected))
  }

  return (
    <div className="drawing-editor">
      <Excalidraw
        key={path}
        excalidrawAPI={setApi}
        initialData={{ elements: scene.elements as unknown as ExcalidrawElement[], appState: { ...scene.appState, theme }, files: scene.files as never, scrollToContent: true }}
        theme={theme}
        langCode="es-ES"
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false } }}
        renderTopRightUI={() => (
          <button className="primary small drawing-ask" onClick={ask} title="Pasarle al chat lo seleccionado (o todo el dibujo)">
            <Icon icon={MessageSquarePlus} size={14} /> {selected.length ? `Preguntar por ${selected.length}` : 'Preguntarle a Alma'}
          </button>
        )}
        onChange={(elements, appState, files) => {
          const ids = Object.keys(appState.selectedElementIds).filter((id) => appState.selectedElementIds[id])
          setSelected((prev) => (prev.join() === ids.join() ? prev : ids))
          // Scrolling, zooming or selecting changes appState only: save just when the drawing itself changed.
          const sceneVersion = getSceneVersion(elements)
          if (sceneVersion === version.current) return
          const first = version.current === -1
          version.current = sceneVersion
          if (first) return
          const json = serialize(elements, appState, files)
          known.current = json
          latest.current.onChange(json)
        }}
      />
    </div>
  )
}
