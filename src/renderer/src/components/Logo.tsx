// The Alma mark: an "A" in a solid Alma-blue speech-bubble tile whose crossbar is the amber dot (the soul).
// variant: base | biz (the crossbar is a team of three) | people (the dot has a halo)
export function Logo({ size = 32, variant = 'base', className = '' }: { size?: number; variant?: 'base' | 'biz' | 'people'; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={`mark ${className}`} aria-hidden="true">
      <path d="M14 6H50Q58 6 58 14V32A26 26 0 0 1 32 58H14Q6 58 6 50V14Q6 6 14 6Z" className="m-tile" />
      <path d="M18 47L32 17L46 47" className="m-a" />
      {variant === 'biz' ? (
        <>
          <circle className="m-dot" cx="26" cy="39" r="2.8" /><circle className="m-dot" cx="32" cy="39" r="2.8" /><circle className="m-dot" cx="38" cy="39" r="2.8" />
        </>
      ) : (
        <circle className="m-dot" cx="32" cy="39" r="4.6" />
      )}
      {variant === 'people' && <circle className="m-ring" cx="32" cy="39" r="8.5" />}
    </svg>
  )
}
