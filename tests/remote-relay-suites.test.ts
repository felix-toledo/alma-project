import { beforeEach } from 'vitest'

// The 026 channel suites, rerun with the relay pair in place of the in-process transport (spec 027 AC-2.1).
// The assertions are the 026 ones, untouched; only the transport the harness builds changes (tests/support/remote-harness.ts).
process.env['ALMA_TEST_TRANSPORT'] = 'relay'

/**
 * Tests whose subject is the transport itself or a zero-latency transport, so they cannot hold over a relay.
 * Each is covered by a relay test of its own (named in `covered`).
 */
export const NOT_OVER_THE_RELAY: Array<{ title: string; why: string; covered: string }> = [
  {
    title: 'AC-3.3 a wrong host or a foreign origin is refused',
    why: 'the relay transport stamps Host and Origin itself; the phone cannot send others',
    covered: 'AC-2.9 (remote-relay-contract.test.ts)'
  },
  {
    title: 'AC-6.10: forget borra el propio device',
    why: 'forget revokes the caller, and revoking a device cuts its session, answer included, as a closed connection would',
    covered: 'AC-8.1 (remote-relay-transport.test.ts)'
  },
  {
    title: 'AC-7.1: answer, control, picture, step-up y forget se auditan',
    why: 'its last step is a forget, which revokes the caller (see the forget entry above); the audit entries do not depend on the transport',
    covered: 'AC-8.1 (remote-relay-transport.test.ts)'
  },
  {
    title: 'AC-1.7: stop suelta los long-polls retenidos sin colgar',
    why: 'stop cuts the connection, so a phone waiting on a held poll sees the PC offline instead of a response, as it does when Tailscale drops its sockets',
    covered: 'AC-1.7 (remote-relay-transport.test.ts) and AC-5.8 (remote-relay-contract.test.ts)'
  },
  {
    title: 'AC-3.11 (028) a held read is released when the channel stops',
    why: 'same: stop cuts the connection, the phone sees the PC offline',
    covered: 'AC-1.7 (remote-relay-transport.test.ts) and AC-5.8 (remote-relay-contract.test.ts)'
  },
  {
    title: 'AC-3.11 (028) an unrelated event leaves the read held',
    why: 'it ends by stopping the channel with the read still held: the phone sees the PC offline',
    covered: 'AC-5.8 (remote-relay-contract.test.ts)'
  },
  {
    title: 'T21: un long-poll retenido despierta cuando llega',
    why: 'it lets 20 microtask turns pass and assumes the request is then held at the handler; a transport with real crypto and hops needs more',
    covered: 'AC-5.8 (remote-relay-contract.test.ts)'
  },
  {
    title: 'AC-3.11 (028) a held read wakes when the run starts and when it ends',
    why: 'same: it assumes the read is held after a few microtask turns',
    covered: 'AC-5.8 (remote-relay-contract.test.ts)'
  },
  {
    title: 'AC-10.4 a request the PC does not finish within 30 seconds ends with an error',
    why: 'it advances fake time right after starting a request, which a transport with real crypto and hops has not delivered yet',
    covered: 'AC-5.8 (remote-relay-contract.test.ts)'
  },
  {
    title: 'AC-10.4 the 30 second cut leaves the 25 second long poll alone',
    why: 'same: fake time advanced before the request reaches the handler',
    covered: 'AC-5.8 (remote-relay-contract.test.ts)'
  },
  {
    title: 'AC-1.7: un long-poll sin cambios vuelve a los 25s con lo actual',
    why: 'same: fake time advanced before the request reaches the handler',
    covered: 'AC-5.8 (remote-relay-contract.test.ts)'
  },
  {
    title: 'AC-3.11 (028) a held read answers with the current state after 25 seconds',
    why: 'same: fake time advanced before the request reaches the handler',
    covered: 'AC-5.8 (remote-relay-contract.test.ts)'
  }
]

beforeEach((context) => {
  if (NOT_OVER_THE_RELAY.some((entry) => context.task.name.startsWith(entry.title))) context.skip()
})

await import('./remote-channel.test')
await import('./remote-authorize.test')
await import('./remote-limits.test')
await import('./remote-audit.test')
await import('./remote-devices.test')
await import('./remote-chat.test')
await import('./remote-approvals.test')
await import('./remote-home.test')
await import('./remote-notes.test')
await import('./remote-notes-scopes.test')
await import('./remote-threads.test')
