// The consent action: four passes over the page looking for the button that
// dismisses a cookie banner. happy-dom has no layout, so every candidate's box
// is pinned with `stubRect`, and the scan clock is driven by the test.

import { beforeEach, describe, expect, test } from "bun:test"

import { handleConsent } from "../src/content/consent"
import type { JsonObject } from "../src/protocol"
import { type FakePage, fakePage, stubRect } from "./dom"
import clickedFixture from "./fixtures/results/handleConsent.json"
import noneFixture from "./fixtures/results/handleConsent-none.json"

beforeEach(() => {
  document.title = "Consent page"
  document.body.innerHTML = ""
})

/** The scan reads `now` on every guard; tests move it by hand. */
interface Clock {
  value: number
}

function timedPage(clock: Clock): FakePage {
  const base = fakePage()
  return { ...base, now: () => clock.value }
}

/** happy-dom resolves no layout: a candidate is only visible once it has a box. */
function withBox(selector: string): HTMLElement {
  const element = document.querySelector(selector)
  if (element === null) {
    throw new Error(`fixture element missing: ${selector}`)
  }
  stubRect(element, { top: 10, left: 10, width: 120, height: 40 })
  return element as HTMLElement
}

interface ClickSpy {
  clicks: number
  scrolls: unknown[]
}

/** Counts the clicks and records the scroll, which happy-dom does not perform. */
function spyOn(element: HTMLElement, onScroll?: () => void): ClickSpy {
  const spy: ClickSpy = { clicks: 0, scrolls: [] }
  element.addEventListener("click", () => {
    spy.clicks++
  })
  Object.defineProperty(element, "scrollIntoView", {
    configurable: true,
    value: (options: unknown) => {
      spy.scrolls.push(options)
      onScroll?.()
    },
  })
  return spy
}

/** Runs the action to completion: the click awaits a frame the fake page owns. */
async function scan(page: FakePage, params: JsonObject = {}): Promise<JsonObject> {
  const pending = handleConsent(params, page)
  await page.advance(0)
  return (await pending) as JsonObject
}

describe("handleConsent", () => {
  test("clicks a known CMP button and reports how it was found", async () => {
    document.body.innerHTML = '<button id="onetrust-accept-btn-handler">Accept all</button>'
    const clock: Clock = { value: 0 }
    const button = withBox("#onetrust-accept-btn-handler")
    const spy = spyOn(button, () => {
      clock.value = 120
    })
    const page = timedPage(clock)

    const result = await scan(page)

    expect(result).toEqual(clickedFixture as unknown as JsonObject)
    expect(spy.clicks).toBe(1)
    expect(spy.scrolls).toEqual([{ behavior: "smooth", block: "center" }])
  })

  test("matches a visible accept button by its text", async () => {
    document.body.innerHTML = '<button class="cta">  Accept all cookies  </button>'
    const spy = spyOn(withBox("button"))
    const page = fakePage()

    expect(await scan(page)).toEqual({
      found: true,
      clicked: true,
      buttonText: "Accept all cookies",
      method: "text-match",
      elapsed: 0,
    })
    expect(spy.clicks).toBe(1)
  })

  test("matches an aria-label when the button carries no text", async () => {
    document.body.innerHTML = '<span role="button" aria-label="I agree"><svg></svg></span>'
    spyOn(withBox('[role="button"]'))

    expect(await scan(fakePage())).toMatchObject({
      buttonText: "I agree",
      method: "text-match",
    })
  })

  test("never clicks a button that rejects", async () => {
    document.body.innerHTML =
      '<button id="reject">Reject all</button><button id="decline">No thanks</button>'
    const reject = spyOn(withBox("#reject"))
    const decline = spyOn(withBox("#decline"))

    expect(await scan(fakePage())).toEqual(noneFixture as unknown as JsonObject)
    expect(reject.clicks + decline.clicks).toBe(0)
  })

  test("never clicks a button whose label only contains an accept phrase", async () => {
    document.body.innerHTML = '<button id="partial">Accept all except tracking</button>'
    const spy = spyOn(withBox("#partial"))

    expect(await scan(fakePage())).toEqual(noneFixture as unknown as JsonObject)
    expect(spy.clicks).toBe(0)
  })

  test("skips a candidate without a box", async () => {
    document.body.innerHTML = '<button id="accept">Accept all</button>'
    const spy = spyOn(document.querySelector("#accept") as HTMLElement)
    stubRect(document.querySelector("#accept") as Element, { width: 0, height: 0 })

    expect(await scan(fakePage())).toEqual(noneFixture as unknown as JsonObject)
    expect(spy.clicks).toBe(0)
  })

  test("reaches an open shadow root under a cookie host", async () => {
    document.body.innerHTML = '<div id="cookie-banner"></div>'
    const root = (document.querySelector("#cookie-banner") as Element).attachShadow({
      mode: "open",
    })
    root.innerHTML = "<button>I agree</button>"
    const spy = spyOn(root.querySelector("button") as HTMLElement)
    stubRect(root.querySelector("button") as Element, { width: 100, height: 30 })

    expect(await scan(fakePage())).toMatchObject({
      found: true,
      clicked: true,
      buttonText: "I agree",
      method: "shadow-dom",
    })
    expect(spy.clicks).toBe(1)
  })

  test("runs the CMP selectors inside the shadow root too", async () => {
    document.body.innerHTML = '<div class="consent-wrapper"></div>'
    const root = (document.querySelector(".consent-wrapper") as Element).attachShadow({
      mode: "open",
    })
    root.innerHTML = '<button id="didomi-notice-agree-button">Zustimmen</button>'
    const spy = spyOn(root.querySelector("button") as HTMLElement)
    stubRect(root.querySelector("button") as Element, { width: 100, height: 30 })

    expect(await scan(fakePage())).toMatchObject({
      buttonText: "Zustimmen",
      method: "shadow-dom",
    })
    expect(spy.clicks).toBe(1)
  })

  test("skips a closed shadow root silently", async () => {
    document.body.innerHTML = '<div id="cookie-banner"></div>'
    const root = (document.querySelector("#cookie-banner") as Element).attachShadow({
      mode: "closed",
    })
    root.innerHTML = "<button>Accept all</button>"
    const spy = spyOn(root.querySelector("button") as HTMLElement)
    stubRect(root.querySelector("button") as Element, { width: 100, height: 30 })

    expect(await scan(fakePage())).toEqual(noneFixture as unknown as JsonObject)
    expect(spy.clicks).toBe(0)
  })

  test("clicks an accept button inside an aria dialog", async () => {
    document.body.innerHTML =
      '<div role="alertdialog"><button class="ok">Got it</button></div>' +
      "<button>Subscribe</button>"
    const spy = spyOn(withBox(".ok"))
    withBox("div[role='alertdialog'] ~ button")

    expect(await scan(fakePage())).toMatchObject({
      found: true,
      clicked: true,
      buttonText: "Got it",
      method: "aria-dialog",
    })
    expect(spy.clicks).toBe(1)
  })

  test("gives up when the scan budget runs out between passes", async () => {
    document.body.innerHTML =
      '<div id="onetrust-banner-sdk"><button id="onetrust-accept-btn-handler">Hidden</button>' +
      "</div><button>Accept all</button>"
    const clock: Clock = { value: 0 }
    const late = document.querySelector("#onetrust-accept-btn-handler") as Element
    // the first pass looks this candidate up and finds no box; the clock jumps
    // past the budget while it does, so no later pass runs
    Object.defineProperty(late, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        clock.value = 4000
        return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 }
      },
    })
    const spy = spyOn(withBox("#onetrust-banner-sdk ~ button"))

    expect(await scan(timedPage(clock))).toEqual({
      found: false,
      clicked: false,
      buttonText: null,
      method: null,
      elapsed: 4000,
    })
    expect(spy.clicks).toBe(0)
  })

  test("answers at once when the budget is already spent", async () => {
    document.body.innerHTML = '<button id="onetrust-accept-btn-handler">Accept all</button>'
    const spy = spyOn(withBox("#onetrust-accept-btn-handler"))

    expect(await scan(fakePage(), { scanTimeout: 0 })).toEqual(noneFixture as unknown as JsonObject)
    expect(spy.clicks).toBe(0)
  })

  test("takes the scan budget from the params", async () => {
    document.body.innerHTML = '<button id="accept">Accept all</button>'
    const clock: Clock = { value: 2000 }
    const spy = spyOn(withBox("#accept"))
    const page = timedPage(clock)
    const pending = handleConsent({ scanTimeout: 5000 }, page)
    clock.value = 4500
    await page.advance(0)

    expect(await pending).toMatchObject({ clicked: true, elapsed: 2500 })
    expect(spy.clicks).toBe(1)
  })
})
