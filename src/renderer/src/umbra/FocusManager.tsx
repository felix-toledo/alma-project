import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { playUISound } from './useUISound'

/**
 * Foco espacial tipo consola.
 * - Todo elemento navegable lleva `data-focusable`.
 * - <FocusScope> groups (menu, modal): it remembers the last focus and, with `trap`, confines navigation.
 * - Teclado: flechas / Enter / Esc. Gamepad: D-pad o stick izq. / A(0) / B(1).
 * - Esc or B fire the `umbra:back` event (each open Modal/Select listens to it).
 */
type Dir = 'up' | 'down' | 'left' | 'right'
// It works with `data-focusable` (new components) and with native buttons/links (existing apps with nothing marked)
const SELECTOR = ':is([data-focusable], button, [role="button"], [role="tab"], a[href], summary, input[type="range"]):not([aria-disabled="true"]):not(:disabled)'
const ScopeCtx = createContext<{ id: string } | null>(null)

function candidates(root: ParentNode) {
  return [...root.querySelectorAll<HTMLElement>(SELECTOR)].filter((e) => e.offsetParent !== null)
}

function activeScope(): HTMLElement | null {
  const scopes = [...document.querySelectorAll<HTMLElement>('[data-focus-scope]')]
  return scopes.filter((s) => s.dataset.trap === 'true').pop() ?? null
}

export function move(dir: Dir) {
  const scope = activeScope() ?? document.body
  const list = candidates(scope)
  const cur = document.activeElement as HTMLElement | null
  if (!cur || !list.includes(cur)) {
    list[0]?.focus()
    return
  }
  const a = cur.getBoundingClientRect()
  const ac = { x: a.left + a.width / 2, y: a.top + a.height / 2 }
  let best: HTMLElement | null = null
  let bestScore = Infinity
  for (const el of list) {
    if (el === cur) continue
    const b = el.getBoundingClientRect()
    const dx = b.left + b.width / 2 - ac.x
    const dy = b.top + b.height / 2 - ac.y
    const [main, cross] = dir === 'left' || dir === 'right' ? [dx, dy] : [dy, dx]
    const sign = dir === 'right' || dir === 'down' ? 1 : -1
    if (main * sign <= 1) continue // it is not in that direction
    const score = Math.abs(main) + Math.abs(cross) * 2.5 // penalizes lateral deviation
    if (score < bestScore) (bestScore = score), (best = el)
  }
  if (best) {
    best.focus()
    best.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    playUISound('focus-move')
  }
}

const KEYS: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }

export function FocusProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === 'Escape') {
        window.dispatchEvent(new CustomEvent('umbra:back'))
        return
      }
      const dir = KEYS[e.key]
      if (!dir) return
      // elementos que consumen flechas horizontales (slider, radiogroup, texto)
      if ((dir === 'left' || dir === 'right') && t.closest('[data-consumes-lr]')) return
      if (t.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select')) return
      e.preventDefault()
      move(dir)
    }
    window.addEventListener('keydown', onKey)

    // Gamepad: polling with rAF, with repeat while held
    let raf = 0
    const held: Record<string, number> = {}
    const press = (name: string, on: boolean, fire: () => void, now: number) => {
      if (!on) return void delete held[name]
      if (held[name] === undefined) (held[name] = now + 380), fire()
      else if (now >= held[name]) (held[name] = now + 120), fire()
    }
    const poll = (now: number) => {
      const gp = [...(navigator.getGamepads?.() ?? [])].find(Boolean)
      if (gp) {
        const b = (i: number) => !!gp.buttons[i]?.pressed
        const [ax, ay] = [gp.axes[0] ?? 0, gp.axes[1] ?? 0]
        press('up', b(12) || ay < -0.6, () => move('up'), now)
        press('down', b(13) || ay > 0.6, () => move('down'), now)
        press('left', b(14) || ax < -0.6, () => move('left'), now)
        press('right', b(15) || ax > 0.6, () => move('right'), now)
        press('ok', b(0), () => (document.activeElement as HTMLElement | null)?.click(), now)
        press('back', b(1), () => window.dispatchEvent(new CustomEvent('umbra:back')), now)
      }
      raf = requestAnimationFrame(poll)
    }
    raf = requestAnimationFrame(poll)
    return () => {
      window.removeEventListener('keydown', onKey)
      cancelAnimationFrame(raf)
    }
  }, [])
  return <>{children}</>
}

/** A focus group with memory. `trap` = modal (it confines navigation and returns focus on close). */
export function FocusScope({
  id,
  trap = false,
  autoFocus = true,
  className,
  children,
}: {
  id: string
  trap?: boolean
  autoFocus?: boolean
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const last = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const el = ref.current!
    const opener = document.activeElement as HTMLElement | null
    const remember = (e: FocusEvent) => (last.current = e.target as HTMLElement)
    el.addEventListener('focusin', remember)
    if (autoFocus) (last.current ?? candidates(el)[0])?.focus()
    return () => {
      el.removeEventListener('focusin', remember)
      if (trap) opener?.focus?.() // al cerrar un modal, vuelve a donde estabas
    }
  }, [autoFocus, trap])

  return (
    <ScopeCtx.Provider value={{ id }}>
      <div ref={ref} data-focus-scope={id} data-trap={trap} className={className}>
        {children}
      </div>
    </ScopeCtx.Provider>
  )
}

export const useFocusScope = () => useContext(ScopeCtx)

/** Listens for "back" (Esc / B button). */
export function useBack(handler: () => void, active = true) {
  const h = useRef(handler)
  h.current = handler
  useEffect(() => {
    if (!active) return
    const fn = () => h.current()
    window.addEventListener('umbra:back', fn)
    return () => window.removeEventListener('umbra:back', fn)
  }, [active])
}
