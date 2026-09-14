// A mutex for the handful of commands that mutate session state across await
// points. The holder keeps the lock until its own promise settles, even when
// the dispatcher has already answered COMMAND_TIMEOUT for it: a late
// tabs.create, tabs.remove or storage write must never interleave with the
// next owner's.

export class StateLock {
  private tail: Promise<void> = Promise.resolve()

  /**
   * Resolves once every earlier holder released; call the returned function to
   * hand the lock on. Releasing twice is a no-op, so a `finally` is safe.
   */
  async acquire(): Promise<() => void> {
    const previous = this.tail
    let release: () => void = () => undefined
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    let held = true
    return () => {
      if (held) {
        held = false
        release()
      }
    }
  }
}
