import { useRef } from 'react'

/**
 * The newest value without being a dependency. `usePwa` returns a new object on every render (each poll), so an effect that
 * lists `pwa` re-asks the PC on every poll; the effect reads `latest.current` instead and depends only on what it truly keys on.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value)
  ref.current = value
  return ref
}
