import { describe, expect, test } from "bun:test"

import { nextFrame, sleep } from "../src/content/timing"
import { fakePage } from "./dom"

describe("nextFrame", () => {
  test("resolves once the double animation frame runs", async () => {
    const page = fakePage()
    const pending = nextFrame(page)
    await page.advance(0)
    await expect(pending).resolves.toBeUndefined()
    expect(page.pending()).toBe(0)
  })

  test("falls back to a timer when animation frames never run, as in a hidden tab", async () => {
    const page = fakePage()
    // simulates a background tab: the browser never invokes rAF callbacks
    page.raf = () => undefined
    const pending = nextFrame(page)
    await page.advance(1000)
    await expect(pending).resolves.toBeUndefined()
  })

  test("clears the fallback timer once the frames resolve it first", async () => {
    const page = fakePage()
    const pending = nextFrame(page)
    await page.advance(0)
    await pending
    expect(page.pending()).toBe(0)
  })
})

describe("sleep", () => {
  test("resolves once the timer is due", async () => {
    const page = fakePage()
    const pending = sleep(page, 100)
    await page.advance(100)
    await expect(pending).resolves.toBeUndefined()
  })
})
