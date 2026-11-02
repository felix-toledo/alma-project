import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Loader2 } from 'lucide-react'
import { playUISound } from '../sound/useUISound'

type Variant = 'primary' | 'secondary' | 'ghost' | 'icon' | 'circle'
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  loading?: boolean
}

const V: Record<Variant, string> = {
  primary: 'bg-accent-solid text-white rounded-pill px-8 border border-white/20',
  secondary: 'glass text-fg rounded-pill px-8',
  ghost: 'text-fg-2 hover:text-fg focus:text-fg rounded-pill px-6 border border-transparent',
  icon: 'glass text-fg rounded-card w-11 px-0',
  circle: 'glass text-fg rounded-full w-14 h-14 px-0',
}

/** Estados: default, hover/focus (escala + halo), active, disabled, loading (aria-busy). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', loading, disabled, onClick, onPointerEnter, className = '', children, ...rest },
  ref,
) {
  const off = disabled || loading
  return (
    <button
      ref={ref}
      data-focusable
      data-solid={variant === 'primary' || undefined}
      aria-disabled={off || undefined}
      aria-busy={loading || undefined}
      className={`inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 text-body font-normal ${V[variant]} ${className}`}
      onPointerEnter={(e) => (!off && playUISound('hover'), onPointerEnter?.(e))}
      onClick={(e) => {
        if (off) return e.preventDefault()
        playUISound('select')
        onClick?.(e)
      }}
      {...rest}
    >
      {loading && <Loader2 className="animate-spin" size={20} strokeWidth={1.75} aria-hidden="true" />}
      {children}
    </button>
  )
})
