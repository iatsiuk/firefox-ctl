import { beforeEach, describe, expect, test } from "bun:test"

import { scroll, waitFor } from "../src/content/wait"
import type { JsonObject } from "../src/protocol"
import { fakePage, stubRect, stubScroll, stubViewport } from "./dom"
import errors from "./fixtures/errors.json"

beforeEach(() => {
  document.title = "Wait page"
  document.body.innerHTML = ""
})

function el(selector: string): HTMLElement {
  const found = document.querySelector(selector)
  if (found === null) {
    throw new Error(`fixture element missing: ${selector}`)
  }
  return found as HTMLElement
}

function result(value: unknown): JsonObject {
  return value as JsonObject
}

/** happy-dom implements scrollIntoView as a no-op; this records its arguments. */
function recordScrollIntoView(element: Element): unknown[] {
  const calls: unknown[] = []
  Object.defineProperty(element, "scrollIntoView", {
    configurable: true,
    value: (options: unknown) => {
      calls.push(options)
    },
  })
  return calls
}

/** Keeps a rejection attached while virtual time runs, then hands it over. */
function caught(pending: Promise<unknown>): Promise<Error> {
  return pending.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => error as Error,
  )
}

describe("scroll", () => {
  test("scrolls an element into view and reports its position", () => {
    document.body.innerHTML = '<div id="box">content</div>'
    const box = el("#box")
    const calls = recordScrollIntoView(box)
    stubRect(box, { left: 12, top: 340, width: 100, height: 40 })

    const value = result(scroll({ selector: "#box" }, fakePage()))

    expect(calls).toEqual([{ behavior: "smooth", block: "center" }])
    expect(value).toEqual({
      selector: "#box",
      scrolledTo: true,
      elementPosition: { x: 12, y: 340 },
    })
  })

  test("passes the requested behavior to scrollIntoView", () => {
    document.body.innerHTML = '<div id="box"></div>'
    const calls = recordScrollIntoView(el("#box"))

    scroll({ selector: "#box", behavior: "instant" }, fakePage())

    expect(calls).toEqual([{ behavior: "instant", block: "center" }])
  })

  test("reports a missing element", () => {
    expect(() => scroll({ selector: "#missing" }, fakePage())).toThrow(
      errors.elementNotFound.replace("<selector>", "#missing"),
    )
  })

  test("validates the selector", () => {
    expect(() => scroll({ selector: "   " }, fakePage())).toThrow(errors.selectorEmpty)
  })

  test("scrolls to coordinates and reports the new position", () => {
    const recorder = stubScroll(window, 0, 0)
    const value = result(scroll({ y: 200 }, fakePage()))

    expect(recorder.calls).toEqual([{ x: 0, y: 200, behavior: "smooth" }])
    expect(value).toEqual({
      scrolledTo: true,
      noEffect: false,
      position: { x: 0, y: 200 },
    })
  })

  test("keeps the current axis when only one coordinate is given", () => {
    const recorder = stubScroll(window, 30, 40)
    const value = result(scroll({ x: 90 }, fakePage()))

    expect(recorder.calls).toEqual([{ x: 90, y: 40, behavior: "smooth" }])
    expect(value.position).toEqual({ x: 90, y: 40 })
  })

  test("marks a scroll that did not move the page", () => {
    stubScroll(window, 0, 200)
    const value = result(scroll({ y: 200 }, fakePage()))

    expect(value.noEffect).toBe(true)
    expect(value.position).toEqual({ x: 0, y: 200 })
  })

  test("reports the current position when neither selector nor coordinates are given", () => {
    stubScroll(window, 5, 120)
    stubViewport(window, 1280, 800)
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: 4200,
    })

    expect(result(scroll({}, fakePage()))).toEqual({
      position: { x: 5, y: 120 },
      pageHeight: 4200,
      viewportHeight: 800,
    })
  })
})

describe("waitFor text mode", () => {
  test("returns as soon as the body contains the text", async () => {
    document.body.innerHTML = "<p>hello firefox-ctl</p>"
    const page = fakePage()
    const pending = waitFor({ text: "firefox-ctl" }, page)
    await page.advance(0)

    expect(result(await pending)).toEqual({ text: "firefox-ctl", found: true, elapsed: 0 })
  })

  test("waits for text that appears later", async () => {
    const page = fakePage()
    const pending = waitFor({ text: "ready" }, page)
    page.setTimeout(() => {
      document.body.innerHTML = "<p>ready</p>"
    }, 250)

    await page.advance(2000)
    const value = result(await pending)
    expect(value.found).toBe(true)
    expect(value.elapsed as number).toBeGreaterThanOrEqual(250)
  })

  test("times out with the text message", async () => {
    const page = fakePage()
    const error = caught(waitFor({ text: "never", timeout: 1000 }, page))
    await page.advance(2000)

    expect((await error).message).toBe('Timeout waiting for text: "never"')
  })

  test("does not sleep past the timeout when the interval is larger", async () => {
    const page = fakePage()
    const error = caught(waitFor({ text: "never", timeout: 1000, interval: 5000 }, page))

    await page.advance(1000)
    expect((await error).message).toBe('Timeout waiting for text: "never"')
  })

  test("wins over a selector, and a url the background already handled", async () => {
    document.body.innerHTML = "<p>both</p>"
    const page = fakePage()
    const pending = waitFor({ text: "both", url: "https://nope/*", selector: "#absent" }, page)
    await page.advance(0)

    expect(result(await pending).text).toBe("both")
  })
})

describe("waitFor selector mode", () => {
  test("reports the element geometry and visibility", async () => {
    document.body.innerHTML = '<div id="box"></div>'
    stubRect(el("#box"), { left: 10, top: 20, width: 200, height: 50 })
    const page = fakePage()
    const pending = waitFor({ selector: "#box" }, page)
    await page.advance(0)

    expect(result(await pending)).toEqual({
      selector: "#box",
      found: true,
      elapsed: 0,
      visible: true,
      position: { x: 10, y: 20, width: 200, height: 50 },
    })
  })

  test("marks a zero-sized element invisible", async () => {
    document.body.innerHTML = '<div id="box"></div>'
    stubRect(el("#box"), {})
    const page = fakePage()
    const pending = waitFor({ selector: "#box" }, page)
    await page.advance(0)

    expect(result(await pending).visible).toBe(false)
  })

  test("waits for an element added later", async () => {
    const page = fakePage()
    const pending = waitFor({ selector: "#late" }, page)
    page.setTimeout(() => {
      document.body.innerHTML = '<div id="late"></div>'
    }, 420)

    await page.advance(3000)
    const value = result(await pending)
    expect(value.found).toBe(true)
    expect(value.elapsed as number).toBeGreaterThanOrEqual(420)
  })

  test("times out with the element message", async () => {
    const page = fakePage()
    const error = caught(waitFor({ selector: "#never", timeout: 500 }, page))
    await page.advance(2000)

    expect((await error).message).toBe("Timeout waiting for element: #never")
  })

  test("does not sleep past the timeout when the interval is larger", async () => {
    const page = fakePage()
    const error = caught(waitFor({ selector: "#never", timeout: 500, interval: 5000 }, page))

    await page.advance(500)
    expect((await error).message).toBe("Timeout waiting for element: #never")
  })

  test("honours a custom interval", async () => {
    const page = fakePage()
    const pending = waitFor({ selector: "#slow", timeout: 5000, interval: 1000 }, page)
    page.setTimeout(() => {
      document.body.innerHTML = '<div id="slow"></div>'
    }, 1500)

    await page.advance(6000)
    const value = result(await pending)
    expect(value.found).toBe(true)
    expect(value.elapsed as number).toBeGreaterThanOrEqual(2000)
  })

  test("requires one of the three modes", async () => {
    await expect(waitFor({}, fakePage())).rejects.toThrow(errors.selectorRequired)
  })
})
