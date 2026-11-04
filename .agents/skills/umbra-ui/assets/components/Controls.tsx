import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { playUISound } from '../sound/useUISound'
import { useBack } from '../nav/FocusManager'

const hov = () => playUISound('hover')

/* ---------- Toggle ---------- */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-focusable
      onPointerEnter={hov}
      onClick={() => {
        if (disabled) return
        playUISound(checked ? 'toggle-off' : 'toggle-on')
        onChange(!checked)
      }}
      className={`relative h-11 w-[72px] shrink-0 cursor-pointer rounded-pill border border-line p-1 ${checked ? 'bg-accent-solid' : 'bg-glass'}`}
    >
      <span
        className="block h-8 w-8 rounded-full bg-white transition-transform duration-[var(--dur-base)] ease-[var(--ease-spring)]"
        style={{ transform: `translateX(${checked ? 28 : 0}px)` }}
      />
    </button>
  )
}

/* ---------- Checkbox ---------- */
export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      data-focusable
      onPointerEnter={hov}
      onClick={() => {
        if (disabled) return
        playUISound(checked ? 'toggle-off' : 'toggle-on')
        onChange(!checked)
      }}
      className="inline-flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-3 text-body"
    >
      <span className={`grid h-6 w-6 place-items-center rounded-md border ${checked ? 'border-accent bg-accent-solid' : 'border-white/30'}`}>
        {checked && <Check size={16} strokeWidth={2.5} aria-hidden="true" />}
      </span>
      {label}
    </button>
  )
}

/* ---------- Radio group (flechas ↑↓ mueven entre opciones, Enter selecciona) ---------- */
export function RadioGroup<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-1">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-focusable
            onPointerEnter={hov}
            onClick={() => (playUISound('select'), onChange(o.value))}
            className="inline-flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-3 text-left text-body"
          >
            <span className={`grid h-6 w-6 place-items-center rounded-full border ${on ? 'border-accent' : 'border-white/30'}`}>
              {on && <span className="h-3 w-3 rounded-full bg-accent" />}
            </span>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/* ---------- Slider (←→ ajustan; ↑↓ salen del control) ---------- */
export function Slider({ value, onChange, min = 0, max = 100, step = 5, label }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; label: string }) {
  const pct = ((value - min) / (max - min)) * 100
  const track = useRef<HTMLDivElement>(null)
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)))
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') (e.preventDefault(), set(value - step), playUISound('focus-move'))
    if (e.key === 'ArrowRight') (e.preventDefault(), set(value + step), playUISound('focus-move'))
  }
  const fromPointer = (clientX: number) => {
    const r = track.current!.getBoundingClientRect()
    set(Math.round((min + ((clientX - r.left) / r.width) * (max - min)) / step) * step)
  }
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      data-focusable
      data-consumes-lr
      onKeyDown={onKey}
      onPointerEnter={hov}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        fromPointer(e.clientX)
      }}
      onPointerMove={(e) => e.buttons === 1 && fromPointer(e.clientX)}
      className="flex min-h-11 w-full cursor-pointer items-center rounded-pill px-3"
    >
      <div ref={track} className="relative h-1.5 w-full rounded-pill bg-white/15">
        <div className="absolute inset-y-0 left-0 rounded-pill bg-accent" style={{ width: `${pct}%` }} />
        <div className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-glow" style={{ left: `${pct}%` }} />
      </div>
    </div>
  )
}

/* ---------- Select (listbox propio, navegable por foco espacial) ---------- */
export function Select<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)
  const close = () => (setOpen(false), btn.current?.focus())
  useBack(close, open)
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
  }, [open])
  return (
    <div className="relative inline-block min-w-56">
      <button
        ref={btn}
        type="button"
        data-focusable
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onPointerEnter={hov}
        onClick={() => (playUISound('select'), setOpen((o) => !o))}
        className="glass flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-pill px-6 text-body"
      >
        {current?.label}
        <ChevronDown size={20} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div ref={list} id={id} role="listbox" aria-label={label} data-focus-scope="select" data-trap="true" className="glass absolute left-0 right-0 top-full z-30 mt-2 flex flex-col gap-1 rounded-card bg-elevated/90 p-2 backdrop-blur-xl">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              data-focusable
              onPointerEnter={hov}
              onClick={() => (playUISound('select'), onChange(o.value), close())}
              className="flex min-h-11 cursor-pointer items-center justify-between rounded-sm px-4 text-left text-body"
            >
              {o.label}
              {o.value === value && <Check size={18} strokeWidth={2} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** A label + control row, for settings lists. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-6">
      <div>
        <div className="text-body text-fg">{label}</div>
        {hint && <div className="text-caption text-fg-2">{hint}</div>}
      </div>
      {children}
    </div>
  )
}
