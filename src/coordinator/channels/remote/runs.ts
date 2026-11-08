export interface RunTie {
  deviceId: string
  threadId: string
  /** Started in the shared remote thread (the Chat tab), as opposed to a conversation by id. */
  shared: boolean
}

/**
 * Which device started which run, in memory only: a restart ends every run anyway. It gives the three rules of
 * spec 028: one phone-started run per device, approvals only for runs the device started, and abort on access cut.
 */
export class RunTies {
  private readonly ties = new Map<string, RunTie>()

  start(deviceId: string, threadId: string, shared = false): { ok: true } | { error: 'run-active' } {
    if (this.ties.has(deviceId)) return { error: 'run-active' }
    this.ties.set(deviceId, { deviceId, threadId, shared })
    return { ok: true }
  }

  end(deviceId: string, threadId: string): void {
    if (this.ties.get(deviceId)?.threadId === threadId) this.ties.delete(deviceId)
  }

  activeFor(deviceId: string): string | null {
    return this.ties.get(deviceId)?.threadId ?? null
  }

  ownerOf(threadId: string): string | null {
    for (const tie of this.ties.values()) if (tie.threadId === threadId) return tie.deviceId
    return null
  }

  /**
   * Cancels every matching run and counts them. The ties stay until each run unwinds and ends itself, so a device
   * cannot start another while the aborted one is still stopping.
   */
  abortWhere(predicate: (tie: RunTie) => boolean, cancel: (threadId: string) => void): number {
    const matching = [...this.ties.values()].filter(predicate)
    for (const tie of matching) cancel(tie.threadId)
    return matching.length
  }
}
