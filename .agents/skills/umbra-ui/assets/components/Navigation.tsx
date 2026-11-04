import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import { Icon } from '../icons/Icon'
import { playUISound } from '../sound/useUISound'

const hov = () => playUISound('hover')

/* ---------- Tabs (barra superior) ---------- */
export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" className="dim-group flex items-center gap-2">
      {tabs.map((t) => {
        const on = t.id === value
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            data-focusable
            onPointerEnter={hov}
            onClick={() => {
              if (!on) playUISound('page-transition')
              onChange(t.id)
            }}
            className={`relative min-h-11 cursor-pointer rounded-pill px-6 text-body ${on ? 'text-fg' : 'text-fg-2'}`}
          >
            {t.label}
            {on && <motion.span layoutId="tab-underline" className="absolute inset-x-6 bottom-1 h-0.5 rounded-pill bg-accent" />}
          </button>
        )
      })}
    </div>
  )
}

/* ---------- MenuList: icon + label, active with a translucent background ---------- */
export interface MenuItem { id: string; label: string; icon: LucideIcon; disabled?: boolean }
export function MenuList({ items, value, onSelect, label }: { items: MenuItem[]; value?: string; onSelect: (id: string) => void; label: string }) {
  return (
    <nav aria-label={label} className="dim-group flex w-72 flex-col gap-1">
      {items.map((it) => (
        <button
          key={it.id}
          data-focusable
          aria-current={it.id === value || undefined}
          aria-disabled={it.disabled || undefined}
          onPointerEnter={hov}
          onClick={() => !it.disabled && (playUISound('select'), onSelect(it.id))}
          className={`flex min-h-12 cursor-pointer items-center gap-4 rounded-card px-4 text-left text-body ${it.id === value ? 'bg-glass-active' : ''}`}
        >
          <Icon icon={it.icon} />
          {it.label}
        </button>
      ))}
    </nav>
  )
}

/* ---------- Tile (juego / app): escala al foco ---------- */
export function Tile({ title, subtitle, art, loading, onClick }: { title: string; subtitle?: string; art?: ReactNode; loading?: boolean; onClick?: () => void }) {
  return (
    <button
      data-focusable
      aria-busy={loading || undefined}
      onPointerEnter={hov}
      onClick={() => (playUISound('select'), onClick?.())}
      className="group flex w-44 cursor-pointer flex-col gap-3 rounded-card p-2 text-left"
    >
      <div className="glass relative grid aspect-square w-full place-items-center overflow-hidden rounded-card bg-gradient-to-br from-accent-solid/30 to-warm/10">
        {loading ? <div className="umbra-skeleton absolute inset-0" /> : art}
      </div>
      <div className="px-1">
        <div className="truncate text-body text-fg">{title}</div>
        {subtitle && <div className="truncate text-caption text-fg-2">{subtitle}</div>}
      </div>
    </button>
  )
}
