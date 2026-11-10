import { answerFor, type HttpAnswer, infoAnswer } from './answer'

export interface RequestLine {
  host: string
  method: string
  path: string
  /** The request asks to become a WebSocket. */
  upgrade: boolean
}

export type Route = { kind: 'pc' | 'frame' | 'info'; id: string } | { kind: 'assets' } | { kind: 'not-found' }

// Lower-case base32, 26 characters: the form a PC makes its routing id in, safe as a host label whatever case the network keeps.
const ID = /^[a-z2-7]{26}$/

export const isRoutingId = (value: string): boolean => ID.test(value)

/** The parts of a request the routing reads. */
export function requestLine(request: Request): RequestLine {
  const url = new URL(request.url)
  return { host: url.host, method: request.method, path: url.pathname, upgrade: request.headers.get('upgrade')?.toLowerCase() === 'websocket' }
}

/** Which part of the relay a request is for. The host is `<routing id>.<relay domain>`; the id is all the relay learns of who is calling. */
export function routeOf({ host, method, path, upgrade }: RequestLine): Route {
  const labels = host.toLowerCase().replace(/:\d+$/, '').split('.')
  const id = labels[0] ?? ''
  if (labels.length < 2 || !ID.test(id)) return { kind: 'not-found' }
  if (path === '/relay/v1/pc') return method === 'GET' && upgrade ? { kind: 'pc', id } : { kind: 'not-found' }
  if (path === '/relay/v1/frame') return method === 'POST' ? { kind: 'frame', id } : { kind: 'not-found' }
  if (path === '/relay/v1/info') return method === 'GET' ? { kind: 'info', id } : { kind: 'not-found' }
  if (path.startsWith('/relay/')) return { kind: 'not-found' }
  return method === 'GET' || method === 'HEAD' ? { kind: 'assets' } : { kind: 'not-found' }
}

export type Plan = { to: 'room'; id: string } | { to: 'assets' } | { to: 'answer'; answer: HttpAnswer }

/** The emergency stop is on for `1` and `true`: a stop that a typo leaves off is worse than one that a typo turns on. */
export const isPaused = (value: string | undefined): boolean => value === '1' || value?.toLowerCase() === 'true'

/** What the Worker does with a request before any room is woken. */
export function planFor(request: RequestLine, paused: boolean): Plan {
  const route = routeOf(request)
  switch (route.kind) {
    case 'not-found':
      return { to: 'answer', answer: answerFor('not-found') }
    case 'info':
      return { to: 'answer', answer: infoAnswer() }
    case 'assets':
      return { to: 'assets' }
    case 'frame':
      // Answered here, so a stopped relay costs no more than one Worker call per request.
      return paused ? { to: 'answer', answer: answerFor('full') } : { to: 'room', id: route.id }
    case 'pc':
      // The room turns the socket away with its own close code.
      return { to: 'room', id: route.id }
  }
}
