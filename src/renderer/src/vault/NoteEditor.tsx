import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { drawSelection, EditorView, keymap, placeholder } from '@codemirror/view'
import { classHighlighter } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import type { VaultEntry } from '../../../shared/types'
import { useLanguage, useT } from '../i18n/useT'
import { assetResolver, livePreview, translator } from './livePreview'
import { resolveAsset } from './vaultLib'

interface Props {
  path: string
  /** What the editor should show. Typing reports changes up; a different value from outside (a reload) replaces the text. */
  content: string
  entries: VaultEntry[]
  /** Scroll to and select this line; `nonce` re-triggers the same line. */
  jump?: { line: number; nonce: number }
  onChange(content: string): void
  onSave(): void
  /** The selected text and its lines, or null when nothing is selected (for "Preguntarle a Alma"). */
  onSelection?(selection: { text: string; lines: [number, number] } | null): void
}

export function NoteEditor({ path, content, entries, jump, onChange, onSave, onSelection }: Props): React.JSX.Element {
  const t = useT()
  const language = useLanguage()
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef({ entries, onChange, onSave, onSelection, path })
  latest.current = { entries, onChange, onSave, onSelection, path }

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: content,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(classHighlighter),
          highlightSelectionMatches(),
          livePreview,
          assetResolver.of((target) => resolveAsset(target, latest.current.path, latest.current.entries)),
          translator.of(t),
          placeholder(t('vault.editorPlaceholder')),
          keymap.of([
            { key: 'Mod-s', run: () => (latest.current.onSave(), true) },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString())
            if (update.selectionSet || update.docChanged) {
              const { from, to } = update.state.selection.main
              const { doc } = update.state
              latest.current.onSelection?.(from === to ? null : { text: doc.sliceString(from, to), lines: [doc.lineAt(from).number, doc.lineAt(to).number] })
            }
          })
        ]
      })
    })
    view.current = editor
    editor.focus()
    return () => {
      editor.destroy()
      view.current = null
    }
    // A new note gets a fresh editor (and undo history); content updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, language])

  useEffect(() => {
    const editor = view.current
    if (!editor || editor.state.doc.toString() === content) return
    const head = Math.min(editor.state.selection.main.head, content.length)
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: content }, selection: { anchor: head } })
  }, [content])

  useEffect(() => {
    const editor = view.current
    if (!editor || !jump) return
    const line = editor.state.doc.line(Math.min(Math.max(1, jump.line), editor.state.doc.lines))
    editor.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
    editor.focus()
  }, [jump])

  return <div className="note-editor" ref={host} />
}
