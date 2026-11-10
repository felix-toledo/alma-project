import { REMOTE_RELAY_LIMITS } from '../../shared/remote/relay-limits'
import { answerGate } from '../gate'

/** The one object that counts an address across every routing id (the rooms are alone with their own). Memory only. */
export class AddressGate {
  private readonly answer = answerGate(REMOTE_RELAY_LIMITS, Date.now)

  async fetch(request: Request): Promise<Response> {
    return Response.json(this.answer(await request.json().catch(() => null)) === true)
  }
}
