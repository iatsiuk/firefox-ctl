// The render-settlement check the background page runs inside the tab before a
// capture. happy-dom paints nothing, so frames, animations and idle slices all
// come from the virtual scheduler.

import { afterEach, describe, expect, test } from "bun:test"

import { checkPageReadiness } from "../src/content/readiness"
import {
  clearAnimations,
  fakePage,
  stubAnimations,
  stubReadyState,
  stubScroll,
  stubViewport,
} from "./dom"
import readinessFixture from "./fixtures/results/checkPageReadiness.json"

function readyPage(): ReturnType<typeof fakePage> {
  const page = fakePage()
  stubReadyState(page.document, "complete")
  stubViewport(page.window, 1280, 800)
  stubScroll(page.window, 0, 120)
  return page
}

afterEach(() => {
  clearAnimations(document)
})

describe("checkPageReadiness", () => {
  test("reports the document state and the viewport after a repaint", async () => {
    const page = readyPage()
    const pending = checkPageReadiness({}, page)
    await page.advance(0)
    expect(await pending).toEqual(readinessFixture)
  })

  test("falls back to the frame timer in a tab whose frames are suspended", async () => {
    const page = readyPage()
    // a background tab: the browser never invokes the rAF callbacks
    page.raf = () => undefined
    const pending = checkPageReadiness({}, page)
    await page.advance(1000)
    expect(await pending).toEqual({ ...readinessFixture, rafWaitMs: 100 })
  })

  test("still finishes in a suspended tab that has an idle callback", async () => {
    const page = readyPage()
    page.raf = () => undefined
    page.enableIdleCallback(20)
    const pending = checkPageReadiness({}, page)
    await page.advance(1000)
    expect(await pending).toEqual({ ...readinessFixture, rafWaitMs: 100, idleWaitMs: 20 })
  })

  test("counts the running animations when the document reports them", async () => {
    const page = readyPage()
    stubAnimations(page.document, [
      { playState: "running" },
      { playState: "finished" },
      { playState: "running" },
    ])
    const pending = checkPageReadiness({}, page)
    await page.advance(0)
    expect(await pending).toEqual({ ...readinessFixture, runningAnimations: 2 })
  })

  test("omits the animation count where the document has no getAnimations", async () => {
    const page = readyPage()
    const pending = checkPageReadiness({}, page)
    await page.advance(0)
    expect(Object.hasOwn((await pending) as object, "runningAnimations")).toBe(false)
  })

  test("waits for an idle slice where the page offers one", async () => {
    const page = readyPage()
    page.enableIdleCallback(30)
    const pending = checkPageReadiness({}, page)
    await page.advance(100)
    expect(await pending).toEqual({ ...readinessFixture, idleWaitMs: 30 })
  })

  test("gives up on the idle slice at its own timeout when the thread stays busy", async () => {
    const page = readyPage()
    // the browser fires the callback at the timeout even when no slice appears
    page.enableIdleCallback(5000)
    const pending = checkPageReadiness({}, page)
    await page.advance(5000)
    expect(await pending).toEqual({ ...readinessFixture, idleWaitMs: 100 })
  })

  test("omits the idle wait where the page has no requestIdleCallback", async () => {
    const page = readyPage()
    const pending = checkPageReadiness({}, page)
    await page.advance(0)
    expect(Object.hasOwn((await pending) as object, "idleWaitMs")).toBe(false)
  })
})
