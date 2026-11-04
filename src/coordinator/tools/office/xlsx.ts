import ExcelJS, { type Cell, type CellFormulaValue, type Workbook, type Worksheet } from 'exceljs'
import Papa from 'papaparse'
import { ToolError } from '../types'
import { openZip } from './xml'

const MAX_CELLS = 3000

export interface SheetSpec {
  name: string
  rows?: (string | number | boolean | null)[][]
  columns?: number[]
  cells?: { ref: string; value?: string | number | boolean | null; formula?: string; bold?: boolean; numFmt?: string; fill?: string }[]
}

export type XlsxOp =
  | { op: 'set'; sheet?: string; ref: string; value?: string | number | boolean | null; formula?: string }
  | { op: 'insert_rows'; sheet?: string; at: number; rows: (string | number | boolean | null)[][] }
  | { op: 'add_sheet'; name: string }
  | { op: 'rename_sheet'; from: string; to: string }

// ---------------------------------------------------------------------------
// Addresses

export function columnNumber(letters: string): number {
  return [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0)
}

export function columnLetters(n: number): string {
  let s = ''
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

interface Box {
  top: number
  left: number
  bottom: number
  right: number
}

function parseBox(range: string | undefined): Box | null {
  if (!range) return null
  const match = /^\s*\$?([A-Z]{1,3})\$?(\d+)(?:\s*:\s*\$?([A-Z]{1,3})\$?(\d+))?\s*$/i.exec(range)
  if (!match) throw new ToolError(`Rango inválido: «${range}». Usá por ejemplo "A1:F100" o "C7".`)
  const [, c1, r1, c2 = c1, r2 = r1] = match
  return { top: Math.min(+r1, +r2), bottom: Math.max(+r1, +r2), left: Math.min(columnNumber(c1), columnNumber(c2)), right: Math.max(columnNumber(c1), columnNumber(c2)) }
}

const inBox = (box: Box | null, row: number, col: number): boolean => !box || (row >= box.top && row <= box.bottom && col >= box.left && col <= box.right)

// ---------------------------------------------------------------------------
// Reading

function show(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().replace(/T00:00:00\.000Z$/, '').replace(/\.000Z$/, 'Z')
  if (typeof value === 'object') {
    const v = value as { richText?: { text: string }[]; text?: unknown; hyperlink?: string; error?: string }
    if (v.richText) return v.richText.map((r) => r.text).join('')
    if (v.hyperlink) return `${show(v.text)} <${v.hyperlink}>`
    if (v.error) return v.error
    return JSON.stringify(value)
  }
  return String(value)
}

function describeCell(cell: Cell): string | null {
  if (cell.formula) {
    const result = cell.result
    return `=${cell.formula} (${result === undefined || result === null ? 'sin calcular' : `valor guardado: ${show(result)}`})`
  }
  const text = show(cell.value)
  return text === '' ? null : text
}

function sheetLines(header: string, cells: [string, string][], box: Box | null, budget: { left: number }): string {
  const shown = cells.slice(0, Math.max(0, budget.left))
  budget.left -= shown.length
  const more = cells.length > shown.length ? `\n… ${cells.length - shown.length} celdas más: pedí un rango (range: "A1:Z200") u otra hoja.` : ''
  return `${header}${box ? ' — filtrado' : ''}\n${shown.map(([ref, text]) => `${ref}: ${text}`).join('\n') || '(sin datos en ese rango)'}${more}`
}

export async function readXlsx(buffer: Buffer, label: string, range?: string, sheet?: string): Promise<string> {
  const wb = await loadWorkbook(buffer, label)
  const sheets = sheet ? wb.worksheets.filter((ws) => ws.name.toLowerCase() === sheet.toLowerCase()) : wb.worksheets
  if (!sheets.length) throw new ToolError(`No existe la hoja «${sheet}». Hojas: ${wb.worksheets.map((ws) => ws.name).join(', ')}.`)
  const box = parseBox(range)
  const budget = { left: MAX_CELLS }
  const parts = sheets.map((ws) => {
    const cells: [string, string][] = []
    ws.eachRow((row, r) => {
      row.eachCell((cell, c) => {
        if (!inBox(box, r, c)) return
        const text = describeCell(cell)
        if (text !== null) cells.push([cell.address, text])
      })
    })
    const used = ws.actualRowCount ? ws.dimensions.range : 'vacía'
    const state = ws.state !== 'visible' ? ' (oculta)' : ''
    return sheetLines(`## Hoja «${ws.name}»${state} — rango usado ${used}`, cells, box, budget)
  })
  return `Libro de Excel con ${wb.worksheets.length} hoja(s): ${wb.worksheets.map((ws) => ws.name).join(', ')}. Formato: celda: valor | =FÓRMULA (valor guardado).\n\n${parts.join('\n\n')}`
}

const csvRows = (buffer: Buffer): string[][] =>
  Papa.parse<string[]>(buffer.toString('utf8').replace(/^﻿/, ''), { skipEmptyLines: 'greedy' }).data

export function readCsv(buffer: Buffer, range?: string): string {
  const rows = csvRows(buffer)
  const box = parseBox(range)
  const cells: [string, string][] = []
  rows.forEach((row, r) => row.forEach((value, c) => value !== '' && inBox(box, r + 1, c + 1) && cells.push([`${columnLetters(c + 1)}${r + 1}`, value])))
  return `CSV de ${rows.length} filas × ${Math.max(0, ...rows.map((r) => r.length))} columnas.\n\n${sheetLines('## Datos', cells, box, { left: MAX_CELLS })}`
}

// ---------------------------------------------------------------------------
// Writing

async function loadWorkbook(buffer: Buffer, label: string): Promise<Workbook> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  } catch (error) {
    throw new ToolError(`No se pudo abrir ${label} como libro de Excel: ${(error as Error).message}`)
  }
  return wb
}

/** "=SUM(A1:A3)" (or `formula`) becomes a formula Excel computes; everything else is a literal value. */
function setCell(cell: Cell, value: string | number | boolean | null | undefined, formula?: string): void {
  const f = formula ?? (typeof value === 'string' && value.startsWith('=') && value.length > 1 ? value : undefined)
  cell.value = f ? { formula: f.replace(/^=/, '') } : (value ?? null)
}

function addSheet(wb: Workbook, name: string): Worksheet {
  if (wb.worksheets.some((ws) => ws.name.toLowerCase() === name.toLowerCase())) throw new ToolError(`Ya existe una hoja «${name}».`)
  try {
    return wb.addWorksheet(name)
  } catch (error) {
    throw new ToolError(`Nombre de hoja inválido «${name}»: ${(error as Error).message} (máximo 31 caracteres, sin : \\ / ? * [ ]).`)
  }
}

export async function createXlsx(sheets: SheetSpec[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  // Excel recomputes every formula when it opens the file (nothing here can compute them).
  wb.calcProperties.fullCalcOnLoad = true
  for (const spec of sheets) {
    const ws = addSheet(wb, spec.name)
    spec.rows?.forEach((row, r) => row.forEach((value, c) => value !== null && value !== '' && setCell(ws.getCell(r + 1, c + 1), value)))
    spec.columns?.forEach((width, i) => (ws.getColumn(i + 1).width = width))
    for (const c of spec.cells ?? []) {
      const cell = ws.getCell(c.ref)
      if (c.formula !== undefined || c.value !== undefined) setCell(cell, c.value, c.formula)
      if (c.bold) cell.font = { ...cell.font, bold: true }
      if (c.numFmt) cell.numFmt = c.numFmt
      if (c.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${c.fill.replace(/^#/, '').toUpperCase()}` } }
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

export function createCsv(sheets: SheetSpec[]): string {
  // BOM so Excel opens accents correctly.
  return `﻿${Papa.unparse((sheets[0]?.rows ?? []).map((row) => row.map((v) => v ?? '')))}`
}

// ---------------------------------------------------------------------------
// Editing

const quoteSheet = (name: string): string => (/^[A-Za-z_][\w.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`)
const unquoteSheet = (prefix: string): string => prefix.slice(0, -1).replace(/^'(.*)'$/, '$1').replace(/''/g, "'")

/** Rewrites the cell references of a formula, leaving "string literals" alone. */
function mapRefs(formula: string, map: (sheet: string | null, col: string, row: number, whole: string) => string): string {
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(
            /(?<![\w.'!$])((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(!])/g,
            (whole, prefix: string | undefined, d1: string, col: string, d2: string, row: string) =>
              map(prefix ? unquoteSheet(prefix) : null, col, Number(row), whole) ?? `${prefix ?? ''}${d1}${col}${d2}${row}`
          )
    )
    .join('')
}

// ponytail: shifts A1 refs in formulas (whole sheets); defined names, conditional formats and validations keep old rows.
function shiftRows(wb: Workbook, target: Worksheet, at: number, count: number): void {
  for (const ws of wb.worksheets) {
    ws.eachRow((row) =>
      row.eachCell((cell) => {
        if (!cell.formula) return
        const shifted = mapRefs(cell.formula, (sheet, col, row, whole) => {
          const same = sheet === null ? ws === target : sheet.toLowerCase() === target.name.toLowerCase()
          return same && row >= at ? whole.replace(/\d+$/, String(row + count)) : whole
        })
        if (shifted !== cell.formula) cell.value = { formula: shifted, result: cell.result } as CellFormulaValue
      })
    )
  }
}

/** Shared formulas point at their master cell by address, which moving rows breaks: make them plain first. */
function unshareFormulas(ws: Worksheet): void {
  ws.eachRow((row) =>
    row.eachCell((cell) => {
      const value = cell.value as { sharedFormula?: string } | null
      if (value && typeof value === 'object' && 'sharedFormula' in value) cell.value = { formula: cell.formula, result: cell.result } as CellFormulaValue
    })
  )
}

export async function editXlsx(buffer: Buffer, label: string, ops: XlsxOp[], force: boolean): Promise<{ buffer: Buffer; changes: string[] }> {
  // exceljs rewrites the whole package and drops what it doesn't model.
  const zip = await openZip(buffer, label)
  const lossy = [
    ['xl/vbaProject.bin', 'macros'],
    ['xl/charts/', 'gráficos'],
    ['xl/pivotTables/', 'tablas dinámicas'],
    ['xl/slicers/', 'segmentaciones']
  ].filter(([prefix]) => Object.keys(zip.files).some((name) => name.startsWith(prefix)))
  if (lossy.length && !force) {
    throw new ToolError(`${label} tiene ${lossy.map(([, what]) => what).join(', ')}, que se perderían al guardarlo desde acá. Pedile al usuario que lo edite en Excel, o repetí con force: true y out: otro archivo .xlsx para guardar una copia sin eso.`)
  }
  const wb = await loadWorkbook(buffer, label)
  const sheetOf = (name?: string): Worksheet => {
    const ws = name ? wb.worksheets.find((s) => s.name.toLowerCase() === name.toLowerCase()) : wb.worksheets[0]
    if (!ws) throw new ToolError(`No existe la hoja «${name}». Hojas: ${wb.worksheets.map((s) => s.name).join(', ')}.`)
    return ws
  }
  const changes: string[] = []
  for (const op of ops) {
    if (op.op === 'set') {
      const ws = sheetOf(op.sheet)
      if (!parseBox(op.ref) || op.ref.includes(':')) throw new ToolError(`set necesita una sola celda (p. ej. "B7"), no «${op.ref}».`)
      const cell = ws.getCell(op.ref.replace(/\$/g, '').toUpperCase())
      const newFormula = op.formula ?? (typeof op.value === 'string' && op.value.startsWith('=') ? op.value : undefined)
      if (cell.formula && newFormula === undefined && !force) {
        throw new ToolError(`${ws.name}!${cell.address} tiene la fórmula =${cell.formula}; no se pisa con un valor fijo. Si el usuario lo pidió, pasá formula o force: true.`)
      }
      setCell(cell, op.value, op.formula)
      changes.push(`${ws.name}!${cell.address} = ${newFormula ? `=${newFormula.replace(/^=/, '')}` : show(op.value)}`)
    } else if (op.op === 'insert_rows') {
      const ws = sheetOf(op.sheet)
      unshareFormulas(ws)
      ws.spliceRows(op.at, 0, ...op.rows.map(() => []))
      shiftRows(wb, ws, op.at, op.rows.length)
      op.rows.forEach((row, r) => row.forEach((value, c) => value !== null && value !== '' && setCell(ws.getCell(op.at + r, c + 1), value)))
      changes.push(`${op.rows.length} fila(s) insertadas en ${ws.name} desde la fila ${op.at} (fórmulas ajustadas)`)
    } else if (op.op === 'add_sheet') {
      addSheet(wb, op.name)
      changes.push(`hoja «${op.name}» agregada`)
    } else {
      const ws = sheetOf(op.from)
      if (wb.worksheets.some((s) => s !== ws && s.name.toLowerCase() === op.to.toLowerCase())) throw new ToolError(`Ya existe una hoja «${op.to}».`)
      const old = ws.name
      ws.name = op.to
      for (const other of wb.worksheets) {
        other.eachRow((row) =>
          row.eachCell((cell) => {
            if (!cell.formula) return
            const renamed = mapRefs(cell.formula, (sheet, _col, _row, whole) => (sheet?.toLowerCase() === old.toLowerCase() ? `${quoteSheet(op.to)}!${whole.slice(whole.lastIndexOf('!') + 1)}` : whole))
            if (renamed !== cell.formula) cell.value = { formula: renamed, result: cell.result } as CellFormulaValue
          })
        )
      }
      changes.push(`hoja «${old}» renombrada a «${op.to}» (referencias actualizadas)`)
    }
  }
  wb.calcProperties.fullCalcOnLoad = true
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), changes }
}
