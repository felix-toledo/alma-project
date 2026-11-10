import { toResponse } from '../answer'
import { isPaused, planFor, requestLine } from '../route'

export { AddressGate } from './gate-object'
export { RoomObject } from './room-object'

// Wiring only: the decisions are in route.ts (tested), and a request for a room is handed to the room of its id.
export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    const plan = planFor(requestLine(request), isPaused(env.RELAY_PAUSED))
    if (plan.to === 'assets') return env.ASSETS.fetch(request)
    if (plan.to === 'answer') return toResponse(plan.answer)
    return env.ROOM.get(env.ROOM.idFromName(plan.id)).fetch(request)
  }
}
