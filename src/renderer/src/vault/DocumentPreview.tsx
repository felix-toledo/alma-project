import JSZip from 'jszip'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { notesText, PresentationError, shapeTexts, slideRefs, tableRows, type XmlNode } from '../../../shared/pptx'
import { useT } from '../i18n/useT'
import { Icon } from '../umbra/Icon'
import { noteName } from './vaultLib'
import './documents.css'

// Read-only previews of Office files and PDFs in the vault. Loaded lazily by VaultView.

const MAX_ROWS = 500

interface Sheet {
  name: string
  rows: string[][]
  total: number
}

interface Slide {
  title: string
  lines: string[]
  tables: string[][][]
  notes: string
}

type Loaded = { kind: 'docx' } | { kind: 'sheets'; sheets: Sheet[] } | { kind: 'slides'; slides: Slide[] }

const parse = (xml: string): XmlNode => new DOMParser().parseFromString(xml, 'application/xml') as unknown as XmlNode

async function loadSheets(buffer: ArrayBuffer, csv: boolean): Promise<Sheet[]> {
  if (csv) {
    const { default: Papa } = await import('papaparse')
    const rows = Papa.parse<string[]>(new TextDecoder().decode(buffer).replace(/^﻿/, ''), { skipEmptyLines: 'greedy' }).data
    return [{ name: 'CSV', rows: rows.slice(0, MAX_ROWS), total: rows.length }]
  }
  const { default: ExcelJS } = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  return wb.worksheets.map((ws) => {
    const rows: string[][] = []
    const width = ws.actualColumnCount ? ws.columnCount : 0
    for (let r = 1; r <= Math.min(ws.rowCount, MAX_ROWS); r++) {
      const row = ws.getRow(r)
      rows.push(
        Array.from({ length: width }, (_, c) => {
          const cell = row.getCell(c + 1)
          // A formula nobody has calculated yet (Excel does it on open): show the formula, not an empty cell.
          return cell.formula && (cell.result === undefined || cell.result === null) ? `=${cell.formula}` : (cell.text ?? '')
        })
      )
    }
    return { name: ws.name, rows, total: ws.rowCount }
  })
}

async function loadSlides(buffer: ArrayBuffer): Promise<Slide[]> {
  const zip = await JSZip.loadAsync(buffer)
  const slides: Slide[] = []
  for (const ref of await slideRefs(zip, parse)) {
    const file = zip.file(ref.path)
    const doc = file ? parse(await file.async('string')) : null
    const shapes = doc ? shapeTexts(doc) : []
    const title = shapes.find((s) => /title|t[ií]tulo/i.test(s.name)) ?? shapes[0]
    slides.push({
      title: title?.lines.join(' ') ?? '',
      lines: shapes.filter((s) => s !== title).flatMap((s) => s.lines),
      tables: doc ? tableRows(doc) : [],
      notes: await notesText(zip, ref, parse)
    })
  }
  return slides
}

function Table({ rows }: { rows: string[][] }): React.JSX.Element {
  return (
    <table>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r}>
            {row.map((cell, c) => (
              <td key={c}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function DocumentPreview({ path, url, onOpen }: { path: string; url: string; onOpen(): void }): React.JSX.Element {
  const t = useT()
  const ext = path.split('.').pop()!.toLowerCase()
  const docxHost = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const [sheet, setSheet] = useState(0)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (ext === 'pdf') return
    let cancelled = false
    setLoaded(null)
    setError('')
    void (async () => {
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) throw new Error(t('vault.doc.openFailed', { status: response.status }))
      const buffer = await response.arrayBuffer()
      if (cancelled) return
      if (ext === 'docx') {
        const { renderAsync } = await import('docx-preview')
        if (cancelled || !docxHost.current) return
        docxHost.current.replaceChildren()
        await renderAsync(buffer, docxHost.current, undefined, { inWrapper: true, ignoreLastRenderedPageBreak: true })
        setLoaded({ kind: 'docx' })
      } else if (ext === 'pptx') {
        const slides = await loadSlides(buffer)
        if (!cancelled) setLoaded({ kind: 'slides', slides })
      } else {
        const sheets = await loadSheets(buffer, ext === 'csv')
        if (!cancelled) (setSheet(0), setLoaded({ kind: 'sheets', sheets }))
      }
    })().catch((e: Error) => !cancelled && setError(e instanceof PresentationError ? t('vault.doc.badPresentation') : e.message || t('vault.doc.showFailed')))
    return () => {
      cancelled = true
    }
  }, [url, ext, reload])

  const current = loaded?.kind === 'sheets' ? loaded.sheets[Math.min(sheet, loaded.sheets.length - 1)] : undefined

  return (
    <div className="doc-preview">
      <div className="doc-preview-bar">
        <span className="ellipsis">{noteName(path)}</span>
        {current && loaded?.kind === 'sheets' && loaded.sheets.length > 1 && (
          <div className="doc-preview-sheets" role="tablist">
            {loaded.sheets.map((s, i) => (
              <button key={s.name} role="tab" aria-selected={s === current} className={`ghost small${s === current ? ' active' : ''}`} onClick={() => setSheet(i)}>
                {s.name}
              </button>
            ))}
          </div>
        )}
        <span className="grow" />
        {ext !== 'pdf' && (
          <button className="ghost small" onClick={() => setReload((n) => n + 1)} title={t('vault.doc.reloadTitle')}>
            <Icon icon={RefreshCw} size={14} /> {t('vault.doc.reload')}
          </button>
        )}
        <button className="ghost small" onClick={onOpen}>
          <Icon icon={ExternalLink} size={14} /> {t('vault.openSystem')}
        </button>
      </div>

      {ext === 'pdf' ? (
        <iframe className="doc-preview-pdf" src={url} title={noteName(path)} />
      ) : (
        <div className="doc-preview-body">
          {error && <div className="vault-empty text-danger">{error}</div>}
          {!error && !loaded && <div className="vault-empty muted">{t('vault.loadingPreview')}</div>}
          {/* docx-preview renders into this node itself. */}
          <div ref={docxHost} className="doc-preview-docx" hidden={ext !== 'docx' || !!error} />
          {current && (
            <div className="doc-preview-sheet">
              {current.rows.length ? <Table rows={current.rows} /> : <p className="muted">{t('vault.doc.emptySheet')}</p>}
              {current.total > current.rows.length && <p className="muted small">{t('vault.doc.rowsShown', { shown: MAX_ROWS, total: current.total })}</p>}
            </div>
          )}
          {loaded?.kind === 'slides' && (
            <ol className="doc-preview-slides">
              {loaded.slides.map((slide, i) => (
                <li key={i} className="doc-preview-slide">
                  <h3>
                    <span className="muted">{i + 1}.</span> {slide.title || t('vault.doc.untitled')}
                  </h3>
                  {slide.lines.length > 0 && (
                    <ul>
                      {slide.lines.map((line, j) => (
                        <li key={j}>{line}</li>
                      ))}
                    </ul>
                  )}
                  {slide.tables.map((rows, j) => (
                    <Table key={j} rows={rows} />
                  ))}
                  {slide.notes && <p className="doc-preview-notes small">{t('vault.doc.notes', { notes: slide.notes })}</p>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}
