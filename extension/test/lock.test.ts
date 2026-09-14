// The mutex guarding session mutations: one holder at a time, in arrival order,
// released only by the holder itself.

import { describe, expect, test } from "bun:test"
import { StateLock } from "../src/lock"

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe("StateLock", () => {
  test("lets the first caller straight in", async () => {
    const lock = new StateLock()
    const release = await lock.acquire()

    expect(typeof release).toBe("function")
    release()
  })

  test("holds later callers until the holder releases, in arrival order", async () => {
    const lock = new StateLock()
    const order: string[] = []
    const first = await lock.acquire()

    const second = lock.acquire().then((release) => {
      order.push("second")
      return release
    })
    const third = lock.acquire().then((release) => {
      order.push("third")
      return release
    })
    await settle()
    expect(order).toEqual([])

    first()
    const releaseSecond = await second
    await settle()
    expect(order).toEqual(["second"])

    releaseSecond()
    await settle()
    expect(order).toEqual(["second", "third"])
    ;(await third)()
  })

  test("ignores a second release from the same holder", async () => {
    const lock = new StateLock()
    const first = await lock.acquire()
    let entered = false
    void lock.acquire().then(() => {
      entered = true
    })

    first()
    first()
    await settle()

    // the doubled release must not hand the lock to a third caller as well
    let third = false
    void lock.acquire().then(() => {
      third = true
    })
    await settle()

    expect(entered).toBe(true)
    expect(third).toBe(false)
  })
})
