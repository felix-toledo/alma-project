import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Bell, CheckCircle2, Info } from 'lucide-react'
import { FocusScope, useBack } from '../nav/FocusManager'
import { playUISound } from '../sound/useUISound'
import { Button } from './Button'

/* ---------- Modal ---------- */
export function Modal({ open, onClose, title, children, actions }: { open: boolean; onClose: () => void; title: string; children: ReactNode; actions: ReactNode }) {
  const id = useId()
  const was = useRef(false)
  useBack(onClose, open)
  useEffect(() => {
    if (open !== was.current) playUISound(open ? 'open-modal' : 'close-modal')
    was.current = open
  }, [open])
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-6 backdrop-blur-[var(--blur-modal)]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.32 }}
          onPointerDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={id}
            className="glass w-full max-w-md rounded-[28px] bg-elevated/70 p-8"
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <FocusScope id="modal" trap>
              <h2 id={id} className="mb-3 text-center text-title font-light">{title}</h2>
              <div className="mb-8 text-center text-fg-2">{children}</div>
              <div className="flex justify-center gap-3">{actions}</div>
            </FocusScope>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/* ---------- Toasts ---------- */
type Kind = 'info' | 'success' | 'warning' | 'error'
interface Toast { id: number; kind: Kind; text: string }
const ToastCtx = createContext<(kind: Kind, text: string) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

const TOAST_ICON = { info: Bell, success: CheckCircle2, warning: AlertTriangle, error: Info }
const TOAST_COLOR = { info: 'text-accent', success: 'text-ok', warning: 'text-warn', error: 'text-bad' }
const TOAST_SOUND = { info: 'notification', success: 'success', warning: 'notification', error: 'error' } as const

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const n = useRef(0)
  const push = useCallback((kind: Kind, text: string) => {
    const id = ++n.current
    setItems((s) => [...s, { id, kind, text }])
    playUISound(TOAST_SOUND[kind])
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 4000)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-8 top-24 z-[60] flex flex-col gap-3" role="status" aria-live="polite">
        <AnimatePresence>
          {items.map((t) => {
            const I = TOAST_ICON[t.kind]
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 40 }}
                transition={{ duration: 0.32, ease: [0.215, 0.61, 0.355, 1] }}
                className="glass flex min-w-64 items-center gap-3 rounded-card bg-elevated/70 px-5 py-4"
              >
                <I size={24} strokeWidth={1.75} className={TOAST_COLOR[t.kind]} aria-hidden="true" />
                <span className="text-body">{t.text}</span>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  )
}

/* ---------- Tooltip (aparece al hover y al foco) ---------- */
export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  const id = useId()
  return (
    <span className="group relative inline-flex" aria-describedby={id}>
      {children}
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-40 mt-3 -translate-x-1/2 whitespace-nowrap rounded-sm border border-line bg-elevated/90 px-3 py-1.5 text-caption text-fg opacity-0 backdrop-blur-xl transition-opacity duration-[var(--dur-base)] group-focus-within:opacity-100 group-hover:opacity-100"
      >
        {text}
      </span>
    </span>
  )
}
