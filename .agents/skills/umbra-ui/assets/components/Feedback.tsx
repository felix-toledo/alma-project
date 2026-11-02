import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { BtnCross, BtnRing, BtnSquare, BtnTriangle } from '../icons/Icon'

/* ---------- Progress / Spinner / Skeleton ---------- */
export function ProgressBar({ value, label }: { value?: number; label: string }) {
  const indeterminate = value === undefined
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : value} className="h-1.5 w-full overflow-hidden rounded-pill bg-white/15">
      <motion.div
        className="h-full rounded-pill bg-accent"
        initial={false}
        animate={indeterminate ? { x: ['-100%', '250%'], width: '40%' } : { x: 0, width: `${value}%` }}
        transition={indeterminate ? { repeat: Infinity, duration: 1.6, ease: 'easeInOut' } : { duration: 0.32 }}
      />
    </div>
  )
}

export function Spinner({ size = 32, label = 'Cargando' }: { size?: number; label?: string }) {
  return <Loader2 role="status" aria-label={label} size={size} strokeWidth={1.5} className="animate-spin text-accent" />
}

export const Skeleton = ({ className = 'h-6 w-full' }: { className?: string }) => (
  <div aria-hidden="true" className={`umbra-skeleton rounded-sm ${className}`} />
)

/* ---------- ControlHints (abajo a la derecha) ---------- */
export type Hint = { key: 'cross' | 'ring' | 'triangle' | 'square'; label: string }
const HINT_ICON = { cross: BtnCross, ring: BtnRing, triangle: BtnTriangle, square: BtnSquare }

export function ControlHints({ hints }: { hints: Hint[] }) {
  return (
    <ul className="fixed bottom-6 right-8 z-20 flex gap-6 text-caption text-fg-2" aria-label="Controles">
      {hints.map((h) => {
        const I = HINT_ICON[h.key]
        return (
          <li key={h.label} className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-full border border-line"><I size={16} /></span>
            {h.label}
          </li>
        )
      })}
    </ul>
  )
}

/* ---------- SystemClock (arriba a la derecha) ---------- */
export function SystemClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(t)
  }, [])
  return (
    <time dateTime={now.toISOString()} className="fixed right-8 top-6 z-20 text-heading font-light tabular-nums">
      {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </time>
  )
}
