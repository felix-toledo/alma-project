import type { CoordinatorRequest, LiveEvent, RequestEnvelope } from '../../../shared/types'

type Pending = { resolve(value: unknown): void; reject(error: Error): void }

let nextId = 1
const pending = new Map<number, Pending>()
const eventListeners = new Set<(event: LiveEvent) => void>()

window.desktop.coordinator.onMessage((message) => {
  if (message.kind === 'event') {
    for (const listener of eventListeners) listener(message.event)
    return
  }
  const waiter = pending.get(message.reqId)
  if (!waiter) return
  pending.delete(message.reqId)
  if (message.ok) waiter.resolve(message.result)
  else waiter.reject(new Error(message.error))
})

/** Sends a request to the agent coordinator over the MessagePort and resolves with its result. */
export function request<T = unknown>(req: CoordinatorRequest): Promise<T> {
  const reqId = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(reqId, { resolve: resolve as (value: unknown) => void, reject })
    window.desktop.coordinator.send({ ...req, kind: 'request', reqId } as RequestEnvelope)
  })
}

export function onEvent(listener: (event: LiveEvent) => void): () => void {
  eventListeners.add(listener)
  return () => eventListeners.delete(listener)
}

export function onConnected(listener: () => void): () => void {
  return window.desktop.coordinator.onConnected(listener)
}
