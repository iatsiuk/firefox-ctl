// A memoised one-shot async attempt with an epoch fence. A caller that gives up
// on the attempt - a command that hit its deadline - abandons it: the memo is
// dropped so the next caller retries, and the epoch moves on so the abandoned
// attempt discards whatever it produces when it finally settles.

export class RestoreMemo {
  private promise?: Promise<void>
  private generation = 0
  // callers currently sharing `promise`; abandoning it only takes effect once
  // every one of them has given up, so one caller's deadline never poisons the
  // result another caller is still legitimately waiting on
  private waiters = 0

  /**
   * Runs `attempt` once, handing it the epoch it must stay inside. `tracked`
   * (the default) registers a waiter that must later call `abandon` to
   * release it; pass `false` for a fire-and-forget caller with no deadline of
   * its own - it shares the same attempt but never counts toward, or blocks,
   * eviction.
   */
  run(attempt: (epoch: number) => Promise<void>, tracked = true): Promise<void> {
    const current = this.promise
    if (current) {
      if (tracked) {
        this.waiters++
      }
      return current
    }
    this.waiters = tracked ? 1 : 0
    const started: Promise<void> = attempt(this.generation).catch((error: unknown) => {
      // a failed attempt is never reused: the next command retries it,
      // regardless of how many callers were still sharing it
      this.evict(started)
      throw error
    })
    this.promise = started
    return started
  }

  /** False once the attempt that captured `epoch` has been abandoned. */
  isCurrent(epoch: number): boolean {
    return epoch === this.generation
  }

  /**
   * One caller gives up on `attempt`. The memo is dropped, and the epoch
   * bumped, only once every caller sharing it has given up too - while even
   * one is still waiting, the attempt must stay trustworthy for it.
   */
  abandon(attempt: Promise<void>): boolean {
    if (this.promise !== attempt) {
      return false
    }
    this.waiters--
    if (this.waiters > 0) {
      return false
    }
    this.evict(attempt)
    return true
  }

  private evict(attempt: Promise<void>): void {
    if (this.promise !== attempt) {
      return
    }
    this.promise = undefined
    this.generation++
    this.waiters = 0
  }
}
