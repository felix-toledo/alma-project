// The floor plan: rooms as glass polygons seen from above, devices as icons you tap. A light that is on bathes its
// room in its own colour. In edit mode rooms, their corners and the devices can be dragged.
import { useMemo, useRef, useState } from 'react'
import { bbox, centroid, pointInPolygon, type HomeThing, type PlanFloor, type Point } from '../../../shared/home'
import { Icon } from '../umbra/Icon'
import { brightnessOf, KIND_ICON, lightColor, TOGGLEABLE, toggleThing } from './homeLib'

interface Props {
  floor: PlanFloor
  things: Map<string, HomeThing>
  edit: boolean
  selected: string | null
  selectedRoom: string | null
  onSelect(ref: string | null): void
  onSelectRoom(id: string | null): void
  /** Edit mode: the floor after a drag finished. */
  onChange(floor: PlanFloor): void
}

type Drag =
  | { kind: 'item'; ref: string; moved: boolean }
  | { kind: 'vertex'; room: string; index: number; moved: boolean }
  | { kind: 'room'; room: string; last: Point; moved: boolean }

const SNAP = 10
const snap = (n: number, step = SNAP): number => Math.round(n / step) * step
const PAD = 90

export function FloorPlan({ floor, things, edit, selected, selectedRoom, onSelect, onSelectRoom, onChange }: Props): React.JSX.Element {
  const svg = useRef<SVGSVGElement>(null)
  const [draft, setDraft] = useState<PlanFloor | null>(null)
  const drag = useRef<Drag | null>(null)
  const shown = draft ?? floor

  const view = useMemo(() => {
    const points: Point[] = [...shown.rooms.flatMap((r) => r.polygon), ...shown.items.map((i): Point => [i.x, i.y])]
    const box = bbox(points)
    const w = Math.max(box.w, 600)
    const h = Math.max(box.h, 400)
    return { x: box.x - PAD - (w - box.w) / 2, y: box.y - PAD - (h - box.h) / 2, w: w + PAD * 2, h: h + PAD * 2 }
  }, [shown.rooms, shown.items])

  const toPlan = (event: React.PointerEvent): Point => {
    const el = svg.current!
    const point = el.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const mapped = point.matrixTransform(el.getScreenCTM()!.inverse())
    return [mapped.x, mapped.y]
  }

  const begin = (event: React.PointerEvent, next: Drag): void => {
    event.stopPropagation()
    svg.current?.setPointerCapture(event.pointerId)
    drag.current = next
    setDraft(structuredClone(floor))
  }

  const move = (event: React.PointerEvent): void => {
    const current = drag.current
    if (!current || !draft) return
    const [x, y] = toPlan(event)
    const next = structuredClone(draft)
    if (current.kind === 'item') {
      const item = next.items.find((i) => i.ref === current.ref)
      if (item) [item.x, item.y] = [snap(x, 5), snap(y, 5)]
    } else if (current.kind === 'vertex') {
      const room = next.rooms.find((r) => r.id === current.room)
      if (room) room.polygon[current.index] = [snap(x), snap(y)]
    } else {
      const [dx, dy] = [snap(x - current.last[0]), snap(y - current.last[1])]
      if (!dx && !dy) return
      const room = next.rooms.find((r) => r.id === current.room)
      if (room) {
        room.polygon = room.polygon.map(([px, py]) => [px + dx, py + dy] as Point)
        // The devices inside go with the room.
        const before = draft.rooms.find((r) => r.id === current.room)!
        for (const item of next.items) if (pointInPolygon([item.x, item.y], before.polygon)) [item.x, item.y] = [item.x + dx, item.y + dy]
        current.last = [current.last[0] + dx, current.last[1] + dy]
      }
    }
    current.moved = true
    setDraft(next)
  }

  const end = (): void => {
    const current = drag.current
    drag.current = null
    if (current?.moved && draft) onChange(draft)
    setDraft(null)
  }

  const clickItem = (ref: string): void => {
    onSelect(ref)
    const thing = things.get(ref)
    if (!edit && thing && thing.available && (TOGGLEABLE.includes(thing.kind) || thing.kind === 'cover')) void toggleThing(thing)
  }

  return (
    <svg
      ref={svg}
      className={`plan-svg${edit ? ' editing' : ''}`}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerDown={() => {
        onSelect(null)
        onSelectRoom(null)
      }}
      role="img"
      aria-label={`Plano de ${floor.name}`}
    >
      <defs>
        {shown.rooms.map((room) => (
          <clipPath key={room.id} id={`clip-${room.id}`}>
            <polygon points={room.polygon.join(' ')} />
          </clipPath>
        ))}
        {shown.items.map((item) => {
          const thing = things.get(item.ref)
          if (thing?.kind !== 'light' || !thing.on || !thing.available) return null
          const color = lightColor(thing)
          return (
            <radialGradient key={item.ref} id={`glow-${item.ref.replace(/\W/g, '_')}`}>
              <stop offset="0%" stopColor={color} stopOpacity={0.75 * brightnessOf(thing)} />
              <stop offset="55%" stopColor={color} stopOpacity={0.3 * brightnessOf(thing)} />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </radialGradient>
          )
        })}
      </defs>

      {shown.rooms.map((room) => {
        const box = bbox(room.polygon)
        const lit = shown.items.filter((i) => {
          const t = things.get(i.ref)
          return t?.kind === 'light' && t.on && t.available && pointInPolygon([i.x, i.y], room.polygon)
        })
        const isSelected = selectedRoom === room.id
        return (
          <g key={room.id}>
            <polygon
              className={`plan-room${isSelected ? ' selected' : ''}${lit.length ? ' lit' : ''}`}
              points={room.polygon.join(' ')}
              onPointerDown={(e) => {
                if (!edit) return
                onSelectRoom(room.id)
                begin(e, { kind: 'room', room: room.id, last: toPlan(e), moved: false })
              }}
            />
            <g clipPath={`url(#clip-${room.id})`} pointerEvents="none">
              {lit.map((i) => (
                <circle key={i.ref} cx={i.x} cy={i.y} r={Math.max(140, Math.min(box.w, box.h) * 0.85)} fill={`url(#glow-${i.ref.replace(/\W/g, '_')})`} className="plan-glow" />
              ))}
            </g>
          </g>
        )
      })}

      {shown.doors.map((door) => (
        <line key={door.id} className="plan-door" x1={door.a[0]} y1={door.a[1]} x2={door.b[0]} y2={door.b[1]} />
      ))}

      {shown.rooms.map((room) => {
        const box = bbox(room.polygon)
        const [cx] = centroid(room.polygon)
        return (
          <g key={`label-${room.id}`} pointerEvents="none">
            <text className="plan-name" x={cx} y={box.y + 40} textAnchor="middle">
              {room.name}
            </text>
            <text className="plan-dims" x={cx} y={box.y + 68} textAnchor="middle">
              {(box.w / 100).toFixed(1)} × {(box.h / 100).toFixed(1)} m
            </text>
          </g>
        )
      })}

      {edit &&
        shown.rooms
          .filter((r) => r.id === selectedRoom)
          .flatMap((room) =>
            room.polygon.map(([x, y], index) => (
              <circle key={`${room.id}-${index}`} className="plan-handle" cx={x} cy={y} r={14} onPointerDown={(e) => begin(e, { kind: 'vertex', room: room.id, index, moved: false })} />
            ))
          )}

      {shown.items.map((item) => {
        const thing = things.get(item.ref)
        if (!thing) return null
        const IconKind = KIND_ICON[thing.kind]
        const on = thing.on && thing.available
        const color = thing.kind === 'light' && on ? lightColor(thing) : undefined
        return (
          <g
            key={item.ref}
            className={`plan-item${on ? ' on' : ''}${!thing.available ? ' off-line' : ''}${selected === item.ref ? ' selected' : ''}${edit ? ' movable' : ''}`}
            transform={`translate(${item.x} ${item.y})`}
            onPointerDown={(e) => {
              e.stopPropagation()
              if (edit) begin(e, { kind: 'item', ref: item.ref, moved: false })
            }}
            onClick={(e) => {
              e.stopPropagation()
              if (!edit || !draft) clickItem(item.ref)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              onSelect(item.ref)
            }}
          >
            <title>{thing.name}</title>
            <circle r={30} className="plan-pin" style={color ? { fill: color } : undefined} />
            <g transform="translate(-16 -16)" className="plan-icon">
              <Icon icon={IconKind} size={32} />
            </g>
            <text className="plan-item-name" y={56} textAnchor="middle">
              {thing.name.length > 16 ? `${thing.name.slice(0, 15)}…` : thing.name}
            </text>
          </g>
        )
      })}

    </svg>
  )
}
