import { useMemo } from 'react'

/** Fondo reutilizable: degradado, haz de luz y bokeh ámbar. `reduceMotion` lo congela. */
export function Backdrop({ particles = 26, reduceMotion = false }: { particles?: number; reduceMotion?: boolean }) {
  const dots = useMemo(
    () =>
      Array.from({ length: particles }, () => ({
        left: Math.random() * 100,
        size: 6 + Math.random() * 26,
        dur: 40 + Math.random() * 60,
        delay: -Math.random() * 90,
        o: 0.15 + Math.random() * 0.45,
        dx: (Math.random() - 0.5) * 120,
      })),
    [particles],
  )
  return (
    <div className="umbra-bg" aria-hidden="true">
      <div className="umbra-beam" style={reduceMotion ? { animationPlayState: 'paused' } : undefined} />
      {dots.map((d, i) => (
        <span
          key={i}
          className="umbra-bokeh"
          style={{
            left: `${d.left}%`,
            width: d.size,
            height: d.size,
            animationDuration: `${d.dur}s`,
            animationDelay: `${d.delay}s`,
            animationPlayState: reduceMotion ? 'paused' : undefined,
            ['--o' as string]: d.o,
            ['--dx' as string]: `${d.dx}px`,
          }}
        />
      ))}
    </div>
  )
}
