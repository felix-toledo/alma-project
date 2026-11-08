import type { FetchLike } from './lib/session'

/** The phone's fetch: relative URLs against the PC that served this page, never a host. */
export const pwaFetch: FetchLike = (url, init) => fetch(url, init)
