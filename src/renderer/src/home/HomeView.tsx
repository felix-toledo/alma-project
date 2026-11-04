// Casa: the house as Alma sees it. A floor plan with live devices, the device list, and the rules. Everything here can
// also be done by asking Alma; both paths end up in the same Home Assistant.
import { Camera, Home, Loader2, Pencil, Plus, Power, Settings as SettingsIcon, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { newId, pointInPolygon, rectPolygon, spotIn, type HomePlan, type HomeThing, type PlanFloor } from '../../../shared/home'
import type { PublicSettings, VaultEntry } from '../../../shared/types'
import { request } from '../lib/coordinator'
import { Icon } from '../umbra/Icon'
import { AddDevice } from './AddDevice'
import { DevicePanel } from './DevicePanel'
import { FloorPlan } from './FloorPlan'
import { control, KIND_ICON, statusText, toggleThing, TOGGLEABLE } from './homeLib'
import { RulesPanel } from './RulesPanel'
import type { useHome } from './useHome'
import './home.css'

type HomeData = ReturnType<typeof useHome>
type Tab = 'plan' | 'devices' | 'rules'

interface Props {
  settings: PublicSettings
  home: HomeData
  onUpdateSettings(patch: Partial<PublicSettings>): Promise<void>
  onOpenSettings(): void
  onOpenChat(): void
  /** The "Agregar dispositivo" dialog; the sidebar can open it too. */
  adding: boolean
  onAdding(open: boolean): void
}

const TAB_KEY = 'alma.home.tab'
const savedTab = (): Tab => {
  try {
    const tab = localStorage.getItem(TAB_KEY)
    return tab === 'devices' || tab === 'rules' ? tab : 'plan'
  } catch {
    return 'plan'
  }
}

/** The engine isn't ready: say where it stands and offer the next step. */
function EngineCard({ settings, home, onUpdateSettings, onOpenSettings }: Pick<Props, 'settings' | 'home' | 'onUpdateSettings' | 'onOpenSettings'>): React.JSX.Element {
  const engine = home.engine
  if (!settings.home.enabled) {
    return (
      <main className="home-view empty-state">
        <Icon icon={Home} size="lg" />
        <h1>Casa</h1>
        <p>Armá el mapa de tu casa, prendé luces, mirá las cámaras y armá modos y reglas. Alma lo maneja con vos: desde acá o por chat, voz y Telegram.</p>
        <button className="primary" onClick={() => void onUpdateSettings({ home: { ...settings.home, enabled: true } })}>
          <Icon icon={Power} size="sm" /> Activar la domótica
        </button>
      </main>
    )
  }
  const external = settings.home.mode === 'external'
  return (
    <main className="home-view empty-state">
      <Icon icon={Home} size="lg" />
      <h1>Casa</h1>
      {!engine && (
        <p>
          <Icon icon={Loader2} size={16} className="spin" /> Conectando…
        </p>
      )}
      {engine?.state === 'missing' && (
        <>
          {external ? (
            <p>Falta la dirección y el token de tu Home Assistant. Se cargan en Configuración → Casa.</p>
          ) : (
            <>
              <p>
                Para manejar los dispositivos Alma instala su propio motor (Home Assistant) dentro de un Linux oculto de Windows (WSL2). Hace falta una sola vez: baja unos <b>1,2 GB</b>, ocupa unos <b>3 GB</b> y tarda unos 10 minutos.
              </p>
              <button className="primary" onClick={() => void request({ method: 'home.install' })}>
                Instalar el motor
              </button>
            </>
          )}
          <button className="ghost" onClick={onOpenSettings}>
            <Icon icon={SettingsIcon} size="sm" /> {external ? 'Configurar' : 'Usar un Home Assistant que ya tengo'}
          </button>
        </>
      )}
      {(engine?.state === 'installing' || engine?.state === 'starting') && (
        <div className="home-progress" role="status">
          <p>
            <Icon icon={Loader2} size={16} className="spin" /> {engine.step ?? 'Trabajando…'}
          </p>
          {engine.progress !== undefined && <progress value={engine.progress} max={1} />}
          <p className="muted small">Podés seguir usando Alma mientras tanto.</p>
        </div>
      )}
      {(engine?.state === 'error' || engine?.state === 'unsupported') && (
        <>
          <p className="text-danger">{engine.error}</p>
          <div className="row">
            {engine.state === 'error' && (
              <button className="primary" onClick={() => void request({ method: 'home.start' })}>
                Reintentar
              </button>
            )}
            <button className="ghost" onClick={onOpenSettings}>
              <Icon icon={SettingsIcon} size="sm" /> Configuración de Casa
            </button>
          </div>
        </>
      )}
    </main>
  )
}

export function HomeView({ settings, home, onUpdateSettings, onOpenSettings, onOpenChat, adding, onAdding: setAdding }: Props): React.JSX.Element {
  const [tab, setTabState] = useState<Tab>(savedTab)
  const setTab = (next: Tab): void => {
    setTabState(next)
    try {
      localStorage.setItem(TAB_KEY, next)
    } catch {
      // A convenience.
    }
  }
  const [edit, setEdit] = useState(false)
  const [floorId, setFloorId] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null)
  const [optimistic, setOptimistic] = useState<HomePlan | null>(null)
  const [drawings, setDrawings] = useState<VaultEntry[] | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => setOptimistic(null), [home.plan])
  useEffect(() => {
    if (home.agentFlow) setAdding(true)
  }, [home.agentFlow])

  const ready = home.engine?.state === 'ready'
  const plan = optimistic ?? home.plan
  const floor: PlanFloor | undefined = plan?.floors.find((f) => f.id === floorId) ?? plan?.floors[0]
  const things = useMemo(() => new Map(home.snapshot.things.map((t) => [t.id, t])), [home.snapshot.things])
  const placed = useMemo(() => new Set(plan?.floors.flatMap((f) => f.items.map((i) => i.ref)) ?? []), [plan])
  const unplaced = home.snapshot.things.filter((t) => !placed.has(t.id))
  const selectedThing = selected ? things.get(selected) : undefined
  const selectedRoomObj = floor?.rooms.find((r) => r.id === selectedRoom)

  if (!settings.home.enabled || !ready) return <EngineCard settings={settings} home={home} onUpdateSettings={onUpdateSettings} onOpenSettings={onOpenSettings} />

  const savePlan = async (next: HomePlan): Promise<void> => {
    setOptimistic(next)
    try {
      await request({ method: 'home.plan.set', plan: next })
    } catch (error) {
      setOptimistic(null)
      setMessage((error as Error).message)
    }
  }
  const saveFloor = (updated: PlanFloor): void => void savePlan({ ...plan!, floors: plan!.floors.map((f) => (f.id === updated.id ? updated : f)), source: { kind: 'manual' } })

  const addRoom = (): void => {
    if (!floor) return
    const right = Math.max(0, ...floor.rooms.flatMap((r) => r.polygon.map((p) => p[0])))
    const top = floor.rooms.length ? Math.min(...floor.rooms.flatMap((r) => r.polygon.map((p) => p[1]))) : 0
    const room = { id: newId('room'), name: `Habitación ${floor.rooms.length + 1}`, areaId: null, polygon: rectPolygon(right, top, 300, 300) }
    saveFloor({ ...floor, rooms: [...floor.rooms, room] })
    setSelectedRoom(room.id)
  }
  const renameRoom = (name: string): void => {
    if (floor && selectedRoomObj && name.trim() && name.trim() !== selectedRoomObj.name) saveFloor({ ...floor, rooms: floor.rooms.map((r) => (r.id === selectedRoomObj.id ? { ...r, name: name.trim() } : r)) })
  }
  const removeRoom = (): void => {
    if (!floor || !selectedRoomObj || !confirm(`¿Borrar la habitación «${selectedRoomObj.name}» del plano? Los dispositivos siguen en la casa.`)) return
    const rooms = floor.rooms.filter((r) => r.id !== selectedRoomObj.id)
    // Devices that were only in this room leave the plan with it.
    const items = floor.items.filter((i) => !pointInPolygon([i.x, i.y], selectedRoomObj.polygon) || rooms.some((r) => pointInPolygon([i.x, i.y], r.polygon)))
    saveFloor({ ...floor, rooms, items })
    setSelectedRoom(null)
  }
  const place = (thing: HomeThing): void => {
    if (!floor) return
    const room = selectedRoomObj ?? floor.rooms.find((r) => r.areaId && r.areaId === thing.areaId) ?? floor.rooms[0]
    if (!room) return setMessage('Primero dibujá una habitación.')
    const [x, y] = spotIn(floor, room)
    saveFloor({ ...floor, items: [...floor.items.filter((i) => i.ref !== thing.id), { ref: thing.id, x: Math.round(x), y: Math.round(y) }] })
  }
  const unplace = (ref: string): void => {
    if (floor) saveFloor({ ...floor, items: floor.items.filter((i) => i.ref !== ref) })
    setSelected(null)
  }
  const addFloor = (): void => {
    const name = prompt('Nombre del piso nuevo', `Piso ${plan!.floors.length + 1}`)?.trim()
    if (!name) return
    const created = { id: newId('piso'), name, rooms: [], doors: [], items: [] }
    void savePlan({ ...plan!, floors: [...plan!.floors, created] })
    setFloorId(created.id)
  }
  const renameFloor = (): void => {
    if (!floor) return
    const name = prompt('Nombre del piso', floor.name)?.trim()
    if (name) saveFloor({ ...floor, name })
  }
  const removeFloor = (): void => {
    if (!floor || plan!.floors.length < 2 || !confirm(`¿Borrar el piso «${floor.name}» del plano?`)) return
    void savePlan({ ...plan!, floors: plan!.floors.filter((f) => f.id !== floor.id) })
    setFloorId(null)
  }

  const loadDrawings = (): void => {
    void request<VaultEntry[]>({ method: 'vault.tree' }).then((tree) => setDrawings(tree.filter((e) => e.kind === 'file' && /\.excalidraw$/i.test(e.path))))
  }
  const fromDrawing = async (path: string): Promise<void> => {
    setMessage('')
    try {
      await request({ method: 'home.plan.fromDrawing', path, floorId: floor?.id })
      setDrawings(null)
    } catch (error) {
      setMessage((error as Error).message)
    }
  }

  const empty = !floor || floor.rooms.length === 0
  const byRoom = new Map<string, HomeThing[]>()
  for (const thing of home.snapshot.things) {
    const name = home.snapshot.areas.find((a) => a.id === thing.areaId)?.name ?? 'Sin habitación'
    byRoom.set(name, [...(byRoom.get(name) ?? []), thing])
  }

  return (
    <main className="home-view">
      <header className="home-header">
        <div className="home-title">
          <Icon icon={Home} size="sm" />
          <h2>Casa</h2>
          <span className="badge ok" title={`Home Assistant ${home.engine?.version ?? ''}`}>
            conectada
          </span>
        </div>
        <nav className="home-tabs" role="tablist" aria-label="Casa">
          {(['plan', 'devices', 'rules'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'plan' ? 'Plano' : t === 'devices' ? `Dispositivos (${home.snapshot.things.length})` : `Reglas (${home.rules.automations.length + home.rules.judgment.length})`}
            </button>
          ))}
        </nav>
        <div className="row">
          {tab === 'plan' && (
            <button className={edit ? 'primary' : 'ghost'} onClick={() => (setEdit(!edit), setSelectedRoom(null))} title="Mover habitaciones y dispositivos">
              <Icon icon={Pencil} size={14} /> {edit ? 'Listo' : 'Editar plano'}
            </button>
          )}
          <button className="primary" onClick={() => setAdding(true)}>
            <Icon icon={Plus} size="sm" /> Agregar dispositivo
          </button>
        </div>
      </header>

      {message && (
        <p className="home-message small text-danger" role="alert" onClick={() => setMessage('')}>
          {message}
        </p>
      )}

      <div className="home-body">
        {tab === 'plan' && plan && floor && (
          <div className="home-plan-layout">
            <section className="home-plan-main">
              <div className="home-floors row">
                {plan.floors.map((f) => (
                  <button key={f.id} className={f.id === floor.id ? 'chip active' : 'chip'} onClick={() => (setFloorId(f.id), setSelectedRoom(null), setSelected(null))}>
                    {f.name}
                  </button>
                ))}
                {edit && (
                  <>
                    <button className="ghost small" onClick={addFloor}>
                      <Icon icon={Plus} size={14} /> Piso
                    </button>
                    <button className="ghost small" onClick={renameFloor}>
                      Renombrar piso
                    </button>
                    {plan.floors.length > 1 && (
                      <button className="ghost small" onClick={removeFloor}>
                        Borrar piso
                      </button>
                    )}
                  </>
                )}
                {plan.source && plan.source.kind !== 'manual' && <span className="muted small">Plano hecho desde {plan.source.kind === 'excalidraw' ? 'un dibujo' : 'una imagen'}</span>}
              </div>

              {empty && !edit ? (
                <div className="home-empty card">
                  <h3>Todavía no hay plano de {floor.name}</h3>
                  <p className="muted">Mostrale a Alma cómo es tu casa y arma las habitaciones. Después ubicás los dispositivos en cada una.</p>
                  <div className="home-options">
                    <button onClick={loadDrawings}>Desde un dibujo de Excalidraw</button>
                    <button onClick={onOpenChat}>Desde una foto o croquis (por chat)</button>
                    <button
                      onClick={() => {
                        setEdit(true)
                        addRoom()
                      }}
                    >
                      Dibujarlo a mano
                    </button>
                  </div>
                  <p className="muted small">
                    <Camera size={13} style={{ verticalAlign: '-2px' }} /> Por chat: pegá o arrastrá la foto del plano y pedile «armá el plano de mi casa con esta imagen». También podés mandarle fotos de cada ambiente.
                  </p>
                  {drawings && (
                    <ul className="home-brands">
                      {drawings.length === 0 && <li className="muted small">No hay dibujos .excalidraw en el vault activo. Dibujá la casa en Conocimientos (un rectángulo por habitación, con su nombre adentro).</li>}
                      {drawings.map((d) => (
                        <li key={d.path}>
                          <button className="home-brand" onClick={() => void fromDrawing(d.path)}>
                            <b>{d.path}</b>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <FloorPlan
                  floor={floor}
                  things={things}
                  edit={edit}
                  selected={selected}
                  selectedRoom={selectedRoom}
                  onSelect={setSelected}
                  onSelectRoom={setSelectedRoom}
                  onChange={saveFloor}
                />
              )}

              {edit && (
                <div className="home-edit-bar card">
                  <div className="row">
                    <button onClick={addRoom}>
                      <Icon icon={Plus} size={14} /> Habitación
                    </button>
                    {selectedRoomObj ? (
                      <>
                        <input key={selectedRoomObj.id} className="home-name" defaultValue={selectedRoomObj.name} onBlur={(e) => renameRoom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label="Nombre de la habitación" />
                        <button className="ghost small danger-text" onClick={removeRoom}>
                          <Icon icon={Trash2} size={14} /> Borrar habitación
                        </button>
                      </>
                    ) : (
                      <span className="muted small">Tocá una habitación para moverla, cambiarle el nombre o arrastrar sus esquinas. Arrastrá los dispositivos para ubicarlos.</span>
                    )}
                  </div>
                  {unplaced.length > 0 && (
                    <div className="home-tray">
                      <span className="muted small">Sin ubicar{selectedRoomObj ? ` (van a ${selectedRoomObj.name})` : ''}:</span>
                      {unplaced.map((thing) => (
                        <button key={thing.id} className="chip" onClick={() => place(thing)} title="Ubicar en el plano">
                          <Icon icon={KIND_ICON[thing.kind]} size={14} /> {thing.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {!edit && home.snapshot.scenes.length > 0 && (
                <div className="home-modes row" aria-label="Modos">
                  {home.snapshot.scenes.map((scene) => (
                    <button key={scene.entityId} onClick={() => void control(scene.entityId, 'scene/turn_on')}>
                      {scene.name}
                    </button>
                  ))}
                </div>
              )}
            </section>
            {selectedThing && (
              <DevicePanel
                thing={selectedThing}
                areas={home.snapshot.areas}
                baseUrl={home.engine?.url}
                onClose={() => setSelected(null)}
              />
            )}
            {edit && selectedThing && (
              <button className="ghost small home-unplace" onClick={() => unplace(selectedThing.id)}>
                Sacar del plano
              </button>
            )}
          </div>
        )}

        {tab === 'devices' && (
          <div className="home-plan-layout">
            <section className="home-devices">
              {home.snapshot.things.length === 0 && (
                <div className="card">
                  <h3>Todavía no hay dispositivos</h3>
                  <p className="muted">Agregá los focos, enchufes y cámaras que tengas (Tuya, Sonoff, Tapo y muchas marcas más).</p>
                  <button className="primary" onClick={() => setAdding(true)}>
                    <Icon icon={Plus} size="sm" /> Agregar dispositivo
                  </button>
                </div>
              )}
              {[...byRoom.entries()].map(([room, list]) => (
                <div key={room} className="home-group">
                  <h3>
                    {room} <span className="muted small">{list.length}</span>
                  </h3>
                  {list.map((thing) => (
                    <div key={thing.id} className={`home-row${selected === thing.id ? ' active' : ''}${thing.available ? '' : ' off-line'}`} onClick={() => setSelected(thing.id)}>
                      <span className={`home-row-icon${thing.on ? ' on' : ''}`}>
                        <Icon icon={KIND_ICON[thing.kind]} size="sm" />
                      </span>
                      <div className="grow">
                        <b>{thing.name}</b>
                        <div className="muted small">{statusText(thing)}</div>
                      </div>
                      {thing.available && (TOGGLEABLE.includes(thing.kind) || thing.kind === 'cover') && (
                        <button
                          role="switch"
                          aria-checked={!!thing.on}
                          aria-label={`Encender ${thing.name}`}
                          className={`home-switch${thing.on ? ' on' : ''}`}
                          onClick={(e) => (e.stopPropagation(), void toggleThing(thing))}
                        >
                          <span />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </section>
            {selectedThing && <DevicePanel thing={selectedThing} areas={home.snapshot.areas} baseUrl={home.engine?.url} onClose={() => setSelected(null)} />}
          </div>
        )}

        {tab === 'rules' && <RulesPanel rules={home.rules} scenes={home.snapshot.scenes} />}
      </div>

      {adding && (
        <AddDevice
          initialStep={home.agentFlow}
          onClose={() => {
            setAdding(false)
            home.clearAgentFlow()
          }}
        />
      )}
    </main>
  )
}

/** Sidebar of the Casa mode: where the engine is, the modes, and a shortcut to add a device. */
export function HomeSidebar({ settings, home, onAdd }: { settings: PublicSettings; home: HomeData; onAdd(): void }): React.JSX.Element {
  if (!settings.home.enabled) return <p className="muted small pad">La domótica está apagada.</p>
  const on = home.snapshot.things.filter((t) => t.kind === 'light' && t.on).length
  return (
    <nav className="home-side" aria-label="Casa">
      <div className="card">
        <b>{home.engine?.state === 'ready' ? 'Casa conectada' : (home.engine?.step ?? 'Motor ' + (home.engine?.state ?? '…'))}</b>
        {home.engine?.state === 'ready' && (
          <span className="muted small">
            {home.snapshot.things.length} dispositivos · {on} luz{on === 1 ? '' : 'ces'} prendida{on === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {home.engine?.state === 'ready' && (
        <>
          <button className="ghost block" onClick={onAdd}>
            <Icon icon={Plus} size="sm" /> Agregar dispositivo
          </button>
          {home.snapshot.scenes.length > 0 && <h4 className="muted small pad">Modos</h4>}
          {home.snapshot.scenes.map((scene) => (
            <button key={scene.entityId} className="ghost block" onClick={() => void control(scene.entityId, 'scene/turn_on')}>
              {scene.name}
            </button>
          ))}
        </>
      )}
    </nav>
  )
}
