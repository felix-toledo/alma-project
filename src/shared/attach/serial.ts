/**
 * Runs the tasks it is given one at a time, in the order they came: a task starts only when the previous one has
 * settled, whether it succeeded or threw. The composer uses it so a second drop or paste waits for the first intake
 * (and its dialog) and then starts from the chips that intake left (spec 030 AC-1.4, BR-14).
 */
export function createSerial(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return (task) => {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}
