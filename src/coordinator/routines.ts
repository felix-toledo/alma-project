import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDue } from '../shared/schedule'
import type { Routine, RoutineState } from '../shared/types'

const TICK_MS = 30_000

/** Runs the user's routines on schedule. Run history lives next to the threads, not in settings. */
export class RoutineRunner {
  private file: string
  private state: Record<string, RoutineState> = {}
  private timer?: NodeJS.Timeout

  constructor(
    dataDir: string,
    private getRoutines: () => Routine[],
    /** Starts the routine (a task gets a new thread; a reminder has none); resolves when it ends. */
    private launch: (routine: Routine) => { threadId?: string; done: Promise<void> },
    private onChange: (state: Record<string, RoutineState>) => void
  ) {
    this.file = join(dataDir, 'routines-state.json')
    if (existsSync(this.file)) {
      try {
        this.state = JSON.parse(readFileSync(this.file, 'utf8'))
      } catch {
        this.state = {}
      }
    }
    // A run can't survive a restart.
    for (const entry of Object.values(this.state)) entry.running = false
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), TICK_MS)
    setTimeout(() => this.tick(), 5_000)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  snapshot(): Record<string, RoutineState> {
    return this.state
  }

  tick(now = new Date()): void {
    for (const routine of this.getRoutines()) {
      const entry = this.state[routine.id]
      if (!entry?.running && isDue(routine, entry?.lastRunAt, now)) this.run(routine)
    }
  }

  run(routine: Routine): string | undefined {
    if (this.state[routine.id]?.running) throw new Error('La rutina ya se está ejecutando.')
    const { threadId, done } = this.launch(routine)
    this.state[routine.id] = { lastRunAt: Date.now(), lastThreadId: threadId, running: true }
    this.save()
    void done.finally(() => {
      this.state[routine.id] = { ...this.state[routine.id], running: false }
      this.save()
    })
    return threadId
  }

  private save(): void {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.state), 'utf8')
    renameSync(tmp, this.file)
    this.onChange(this.state)
  }
}
