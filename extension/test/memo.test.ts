import { describe, expect, test } from "bun:test"
import { RestoreMemo } from "../src/memo"

describe("RestoreMemo", () => {
  test("runs the attempt once and hands out the same promise", async () => {
    const memo = new RestoreMemo()
    let runs = 0
    const attempt = () => {
      runs++
      return Promise.resolve()
    }

    const first = memo.run(attempt)
    const second = memo.run(attempt)

    expect(first).toBe(second)
    await first
    await memo.run(attempt)
    expect(runs).toBe(1)
  })

  test("drops a rejected attempt so the next call retries", async () => {
    const memo = new RestoreMemo()
    let runs = 0
    const attempt = () => {
      runs++
      return runs === 1 ? Promise.reject(new Error("storage unavailable")) : Promise.resolve()
    }

    await expect(memo.run(attempt)).rejects.toThrow("storage unavailable")
    await memo.run(attempt)

    expect(runs).toBe(2)
  })

  test("an abandoned attempt is no longer current and is retried", async () => {
    const memo = new RestoreMemo()
    const epochs: number[] = []
    const stuck = memo.run((epoch) => {
      epochs.push(epoch)
      return new Promise<void>(() => undefined)
    })

    expect(memo.abandon(stuck)).toBe(true)
    expect(memo.isCurrent(epochs[0] as number)).toBe(false)

    await memo.run((epoch) => {
      epochs.push(epoch)
      return Promise.resolve()
    })

    expect(epochs).toEqual([0, 1])
    expect(memo.isCurrent(1)).toBe(true)
  })

  test("an attempt shared by two callers stays current until both give up", async () => {
    const memo = new RestoreMemo()
    const epochs: number[] = []
    const stuck = memo.run((epoch) => {
      epochs.push(epoch)
      return new Promise<void>(() => undefined)
    })
    const joined = memo.run(() => new Promise<void>(() => undefined))
    expect(joined).toBe(stuck)

    // the first caller gives up, but the second is still waiting on the same
    // attempt, so it must not be evicted or discarded out from under it
    expect(memo.abandon(stuck)).toBe(false)
    expect(memo.isCurrent(epochs[0] as number)).toBe(true)

    // once the last caller gives up too, the attempt is finally abandoned
    expect(memo.abandon(stuck)).toBe(true)
    expect(memo.isCurrent(epochs[0] as number)).toBe(false)
  })

  test("an untracked caller never blocks or requires abandoning the attempt", async () => {
    const memo = new RestoreMemo()
    const epochs: number[] = []
    // a fire-and-forget warm-up with no deadline of its own joins first
    const warmup = memo.run((epoch) => {
      epochs.push(epoch)
      return new Promise<void>(() => undefined)
    }, false)
    const tracked = memo.run(() => new Promise<void>(() => undefined))
    expect(tracked).toBe(warmup)

    // the one real, tracked caller gives up: the untracked warm-up never
    // registered as a waiter, so this alone is enough to evict
    expect(memo.abandon(tracked)).toBe(true)
    expect(memo.isCurrent(epochs[0] as number)).toBe(false)
  })

  test("abandoning a promise that is no longer memoised changes nothing", async () => {
    const memo = new RestoreMemo()
    const stuck = memo.run(() => new Promise<void>(() => undefined))
    memo.abandon(stuck)
    const fresh = memo.run(() => Promise.resolve())

    expect(memo.abandon(stuck)).toBe(false)
    expect(memo.isCurrent(1)).toBe(true)
    expect(memo.run(() => Promise.reject(new Error("must not run")))).toBe(fresh)
    await fresh
  })
})
